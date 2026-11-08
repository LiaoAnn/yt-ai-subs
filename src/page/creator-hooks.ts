// The creator's own caption tracks (MAIN world). For every player response it notes the
// video's caption tracks; then either
// - a creator track in our track's language exists (a zh-Hant track for a zh-TW viewer):
//   our track is not added, and that track is selected once per video instead; or
// - a creator track in the spoken language exists: it and YouTube's automatic track of
//   that language are fetched, and the content script decides whether to use it instead
//   of Whisper (analyzeCreatorTrack in src/shared/creator-captions.ts).
//
// Fetching a track needs the player's proof-of-origin token (`pot`): a bare baseUrl comes
// back empty. The player adds it to every timedtext request it makes, including the one for
// our own track (whose baseUrl copies a real track's parameters for that reason), and one
// token works for all tracks of the video. So nothing is fetched until the player has made
// such a request. Logic is in creator-captions.ts; this file is the glue.

import type { Json3Event } from "@/shared/captions";
import {
  readCaptionTracks,
  sourceTracks,
  targetTrack,
  type CaptionTrackInfo,
} from "@/shared/creator-captions";
import { LOG_PREFIX } from "@/shared/log";
import { PAGE_MESSAGE_TAG, type CreatorCaptionsMessage } from "@/shared/messages";
import type { TrackConfig } from "@/shared/track-config";
import { isOurVssId } from "./caption-track";

/** Give up on the token after this much ad-free time with the video loaded. */
const TOKEN_WAIT_MS = 12_000;
const MAX_VIDEOS = 8;
/** Parameters that belong to a track, not to the player's request. */
const TRACK_PARAMS = new Set(["v", "lang", "kind", "name", "tlang", "fmt", "ytaisubs"]);

interface VideoCreator {
  target: CaptionTrackInfo | null;
  source: { creator: CaptionTrackInfo; asr: CaptionTrackInfo | null } | null;
  /** The player's own parameters from a timedtext request for this video (with pot). */
  playerParams: URLSearchParams | null;
  status: CreatorCaptionsMessage["status"];
  result: Omit<CreatorCaptionsMessage, typeof PAGE_MESSAGE_TAG | "type" | "videoId"> | null;
  /** Ad-free time the video has waited for the token. */
  waitedMs: number;
  targetSelected: boolean;
}

const videos = new Map<string, VideoCreator>();
let nativeFetch: typeof fetch = (...args) => fetch(...args);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The video ID and caption tracks of a playable player response. */
function responseTracks(response: unknown) {
  if (!isObject(response)) return null;
  const details = response.videoDetails;
  const playability = response.playabilityStatus;
  if (!isObject(details) || typeof details.videoId !== "string") return null;
  if (!isObject(playability) || playability.status !== "OK") return null;
  const captions = response.captions;
  const renderer = isObject(captions) ? captions.playerCaptionsTracklistRenderer : null;
  const list = isObject(renderer) ? renderer.captionTracks : null;
  return { videoId: details.videoId, tracks: readCaptionTracks(list, isOurVssId) };
}

/**
 * Notes a player response's tracks (before ours is added). Returns the creator track in
 * our track's language if there is one: then our track must not be added.
 */
export function noteResponse(response: unknown, config: TrackConfig): CaptionTrackInfo | null {
  if (!config.enabled) return null;
  const found = responseTracks(response);
  if (!found) return null;
  const target = config.translate ? targetTrack(found.tracks, config.languageCode) : null;
  const source = target ? null : sourceTracks(found.tracks, config.sourceLanguage);
  const known = videos.get(found.videoId);
  // A second response for the same video (prefetch, then the real load): keep what is
  // known, unless the plan changed (settings changed in between).
  if (
    known &&
    known.target?.vssId === target?.vssId &&
    known.source?.creator.vssId === source?.creator.vssId
  ) {
    return known.target;
  }
  const entry: VideoCreator = {
    target,
    source,
    playerParams: known?.playerParams ?? null,
    status: target ? "target" : source ? "pending" : "none",
    result: null,
    waitedMs: 0,
    targetSelected: false,
  };
  videos.delete(found.videoId);
  videos.set(found.videoId, entry);
  while (videos.size > MAX_VIDEOS) videos.delete(videos.keys().next().value!);
  if (target) {
    console.log(
      LOG_PREFIX,
      `creator track in ${target.languageCode} for ${found.videoId}: using it, no AI track`,
    );
  } else if (source) {
    console.log(
      LOG_PREFIX,
      `creator track in ${source.creator.languageCode} for ${found.videoId}: will fetch it`,
    );
  }
  return target;
}

/** Remembers the player's parameters (with its pot token) from a timedtext request. */
export function noteTimedtextUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url, location.href);
  } catch {
    return;
  }
  if (parsed.pathname !== "/api/timedtext" || !parsed.searchParams.get("pot")) return;
  const videoId = parsed.searchParams.get("v");
  const entry = videoId ? videos.get(videoId) : undefined;
  if (!entry || entry.playerParams) return;
  entry.playerParams = parsed.searchParams;
}

function trackUrl(track: CaptionTrackInfo, playerParams: URLSearchParams): string {
  const url = new URL(track.baseUrl, location.href);
  for (const [name, value] of playerParams) {
    if (!TRACK_PARAMS.has(name) && !url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  url.searchParams.set("fmt", "json3");
  return url.href;
}

/** A json3 body's events, in the shape the messages check (text segments only). */
function eventsOf(body: unknown): Json3Event[] {
  if (!isObject(body) || !Array.isArray(body.events)) return [];
  const events: Json3Event[] = [];
  for (const event of body.events) {
    if (!isObject(event) || typeof event.tStartMs !== "number" || !Array.isArray(event.segs))
      continue;
    const segs = event.segs
      .filter((seg): seg is Json => isObject(seg) && typeof seg.utf8 === "string")
      .map((seg) => ({ utf8: seg.utf8 as string }));
    if (!segs.length) continue;
    const duration = typeof event.dDurationMs === "number" ? event.dDurationMs : 0;
    events.push({ tStartMs: event.tStartMs, dDurationMs: duration, segs });
  }
  return events;
}

async function fetchTrack(track: CaptionTrackInfo, playerParams: URLSearchParams) {
  const response = await nativeFetch(trackUrl(track, playerParams), { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error("empty body");
  return eventsOf(JSON.parse(text));
}

async function fetchSource(videoId: string, entry: VideoCreator) {
  const { source, playerParams } = entry;
  if (!source || !playerParams) return;
  entry.status = "pending";
  try {
    const [creator, asr] = await Promise.all([
      fetchTrack(source.creator, playerParams),
      source.asr ? fetchTrack(source.asr, playerParams) : Promise.resolve(null),
    ]);
    if (!creator.length) throw new Error("no lines");
    entry.status = "fetched";
    entry.result = {
      status: "fetched",
      languageCode: source.creator.languageCode,
      name: source.creator.name,
      creator,
      asr,
    };
    console.log(
      LOG_PREFIX,
      `creator track fetched for ${videoId}: ${creator.length} events` +
        (asr ? `, automatic ${asr.length}` : ", no automatic track"),
    );
  } catch (error) {
    entry.status = "failed";
    entry.result = {
      status: "failed",
      reason: `抓不到創作者字幕（${String(error).slice(0, 80)}）`,
    };
    console.warn(LOG_PREFIX, `could not fetch the creator track for ${videoId}`, error);
  }
}

const fetching = new Set<string>();

interface PlayerLike {
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

/**
 * Every control tick (500 ms): fetches the spoken-language track once the token is known,
 * gives up after a while without one, and selects a target-language track once per video.
 */
export function creatorTick(
  player: PlayerLike | null,
  videoId: string | null,
  adShowing: boolean,
  elapsedMs: number,
) {
  const entry = videoId ? videos.get(videoId) : undefined;
  if (!videoId || !entry || adShowing) return;
  if (entry.status === "pending" && !fetching.has(videoId)) {
    if (entry.playerParams) {
      fetching.add(videoId);
      void fetchSource(videoId, entry).finally(() => fetching.delete(videoId));
    } else if ((entry.waitedMs += elapsedMs) >= TOKEN_WAIT_MS) {
      entry.status = "failed";
      entry.result = { status: "failed", reason: "播放器沒有載入任何字幕，抓不到創作者字幕" };
      console.warn(LOG_PREFIX, `no timedtext token for ${videoId}: creator track not fetched`);
    }
  }
  if (entry.target && !entry.targetSelected && player?.getOption && player.setOption) {
    try {
      const list = player.getOption("captions", "tracklist");
      const wanted = entry.target.vssId;
      const track = Array.isArray(list)
        ? (list as { vss_id?: string }[]).find((item) => item?.vss_id === wanted)
        : undefined;
      if (track) {
        entry.targetSelected = true;
        const current = player.getOption("captions", "track") as { vss_id?: string } | undefined;
        if (current?.vss_id !== wanted) {
          player.setOption("captions", "track", track);
          console.log(LOG_PREFIX, `creator track ${wanted} selected for ${videoId}`);
        }
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "could not select the creator track", error);
    }
  }
}

/** The creator track in our language that replaced our track for this video, if any. */
export function targetFor(videoId: string | null): CaptionTrackInfo | null {
  return (videoId && videos.get(videoId)?.target) || null;
}

/** Answers the content script's question about a video. */
export function creatorMessage(videoId: string): CreatorCaptionsMessage {
  const entry = videos.get(videoId);
  const base = { [PAGE_MESSAGE_TAG]: true as const, type: "creator-captions" as const, videoId };
  if (!entry) return { ...base, status: "unknown" };
  if (entry.result) return { ...base, ...entry.result };
  if (entry.target) {
    return {
      ...base,
      status: "target",
      languageCode: entry.target.languageCode,
      name: entry.target.name,
    };
  }
  if (entry.source) {
    return {
      ...base,
      status: entry.status,
      languageCode: entry.source.creator.languageCode,
      name: entry.source.creator.name,
    };
  }
  return { ...base, status: "none" };
}

/** Call before the fetch hook is installed, so the tracks are fetched with the real fetch. */
export function installCreatorCaptions() {
  const original = window.fetch;
  nativeFetch = (input, init) => original.call(window, input, init);
}
