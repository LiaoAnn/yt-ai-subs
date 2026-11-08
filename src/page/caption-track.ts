// Pure logic behind the AI caption track in YouTube's caption (CC) menu. The browser glue
// that applies it lives in caption-hooks.ts; how it works and how it breaks is in
// .claude/skills/debug-caption-track/SKILL.md.
//
// 1. Every player response gets one more entry in
//    captions.playerCaptionsTracklistRenderer.captionTracks, whose baseUrl carries
//    TRACK_MARKER (patchPlayerResponse).
// 2. When the player requests that baseUrl (/api/timedtext, json3), the page script answers
//    with our cues instead of letting the request reach YouTube (ourTrackVideoId).
// 3. TrackHealth decides, from what the player reports, whether the track works or the
//    content script should fall back to its overlay.

import type { Json3Event } from "@/shared/captions";
import type { TrackConfig } from "@/shared/track-config";

/** Query parameter and vssId suffix that mark our track. */
export const TRACK_MARKER = "ytaisubs";

export const trackVssId = (languageCode: string) => `.${languageCode}.${TRACK_MARKER}`;

export const isOurVssId = (vssId: unknown): boolean =>
  typeof vssId === "string" && vssId.endsWith(`.${TRACK_MARKER}`);

/**
 * Our track's URL. With `template` (a real track's baseUrl from the same response), its
 * parameters are kept: the player adds its proof-of-origin token (`pot`) only to URLs that
 * look like a real track's, and the page script needs that token to fetch the creator's
 * tracks (see creator-hooks). The request never leaves the page either way.
 */
export function trackBaseUrl(videoId: string, languageCode: string, template?: string): string {
  let url: URL | null = null;
  if (template) {
    try {
      url = new URL(template, "https://www.youtube.com/");
      if (url.hostname !== "www.youtube.com" || url.pathname !== "/api/timedtext") url = null;
    } catch {
      url = null;
    }
  }
  url ??= new URL("https://www.youtube.com/api/timedtext");
  for (const name of ["kind", "name", "tlang", "fmt"]) url.searchParams.delete(name);
  url.searchParams.set("v", videoId);
  url.searchParams.set("lang", languageCode);
  url.searchParams.set(TRACK_MARKER, "1");
  return url.href;
}

/** The video ID if `url` is a timedtext request for our track, else null. */
export function ourTrackVideoId(url: string): string | null {
  try {
    const parsed = new URL(url, "https://www.youtube.com/");
    if (parsed.hostname !== "www.youtube.com" || parsed.pathname !== "/api/timedtext") return null;
    if (parsed.searchParams.get(TRACK_MARKER) !== "1") return null;
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a player response is a live stream's (`videoDetails.isLive`), or null when it has
 * no video ID. A finished stream's recording comes with `isLive` absent or false.
 */
export function liveStatus(response: unknown): { videoId: string; live: boolean } | null {
  if (!isObject(response) || !isObject(response.videoDetails)) return null;
  const { videoId, isLive } = response.videoDetails;
  return typeof videoId === "string" ? { videoId, live: isLive === true } : null;
}

/**
 * Adds our track to a player response (in place). Returns the video ID when it did, null
 * when the response is not a playable video's, is a live stream's or already has the track.
 */
export function patchPlayerResponse(response: unknown, config: TrackConfig): string | null {
  if (!config.enabled || !isObject(response)) return null;
  const details = response.videoDetails;
  const playability = response.playabilityStatus;
  if (!isObject(details) || typeof details.videoId !== "string") return null;
  if (!isObject(playability) || playability.status !== "OK") return null;
  if (details.isLive === true) return null; // no captions for live streams
  const videoId = details.videoId;

  let captions = response.captions;
  if (!isObject(captions)) captions = response.captions = {};
  let renderer = (captions as Json).playerCaptionsTracklistRenderer;
  if (!isObject(renderer)) renderer = (captions as Json).playerCaptionsTracklistRenderer = {};
  const list = renderer as Json;
  if (!Array.isArray(list.captionTracks)) list.captionTracks = [];
  const tracks = list.captionTracks as unknown[];
  if (tracks.some((existing) => isObject(existing) && isOurVssId(existing.vssId))) return null;
  const template = tracks.find(
    (existing) => isObject(existing) && typeof existing.baseUrl === "string",
  ) as Json | undefined;
  const track = {
    baseUrl: trackBaseUrl(videoId, config.languageCode, template?.baseUrl as string | undefined),
    name: { simpleText: config.label },
    vssId: trackVssId(config.languageCode),
    languageCode: config.languageCode,
    isTranslatable: false,
    trackName: config.label,
  };
  const index = tracks.push(track) - 1;

  if (!Array.isArray(list.audioTracks) || list.audioTracks.length === 0) {
    list.audioTracks = [{ captionTrackIndices: [] }];
  }
  for (const audio of list.audioTracks as unknown[]) {
    if (!isObject(audio)) continue;
    if (!Array.isArray(audio.captionTrackIndices)) audio.captionTrackIndices = [];
    (audio.captionTrackIndices as number[]).push(index);
  }
  if (!Array.isArray(list.translationLanguages)) list.translationLanguages = [];
  if (typeof list.defaultAudioTrackIndex !== "number") list.defaultAudioTrackIndex = 0;
  return videoId;
}

/**
 * The player responses inside a youtubei JSON body: /player returns one, /get_watch (SPA
 * navigation) an array of parts, one of them `{playerResponse: …}`.
 */
export function playerResponsesIn(body: unknown, depth = 0): Json[] {
  if (depth > 3) return [];
  if (Array.isArray(body)) return body.flatMap((part) => playerResponsesIn(part, depth + 1));
  if (!isObject(body)) return [];
  if (isObject(body.videoDetails) && isObject(body.playabilityStatus)) return [body];
  return playerResponsesIn(body.playerResponse, depth + 1);
}

/** youtubei endpoints whose responses carry a player response. */
export const isPlayerEndpoint = (url: string) =>
  /\/youtubei\/v1\/(player|get_watch)(\?|$)/.test(url);

/** Events whose middle part (a margin inside each end) covers `seconds`. */
export function activeEvents(
  events: readonly Json3Event[],
  seconds: number,
  marginMs = 300,
): Json3Event[] {
  const ms = seconds * 1000;
  return events.filter(
    (event) =>
      event.dDurationMs > 2 * marginMs &&
      event.tStartMs + marginMs <= ms &&
      ms <= event.tStartMs + event.dDurationMs - marginMs,
  );
}

const squash = (text: string) => text.replace(/\s+/g, "");
const eventText = (event: Json3Event) => event.segs.map((seg) => seg.utf8).join("");

/** True if the caption text on screen contains any of the expected events. */
export function showsAnyOf(shown: string, expected: readonly Json3Event[]): boolean {
  const onScreen = squash(shown);
  return expected.some((event) => {
    const text = squash(eventText(event));
    return text.length > 0 && onScreen.includes(text);
  });
}

/** Reload the player's copy of the track now, or wait for a gap between captions. */
export function shouldReloadNow(opts: {
  now: number;
  /** When the cues changed after the player last loaded them; 0 if they did not. */
  staleSince: number;
  /** A caption the player already has is on screen right now. */
  captionShowing: boolean;
  paused: boolean;
  maxWaitMs?: number;
}): boolean {
  if (!opts.staleSince) return false;
  if (opts.paused || !opts.captionShowing) return true;
  return opts.now - opts.staleSince >= (opts.maxWaitMs ?? 3000);
}

export type TrackMode = "pending" | "cc" | "overlay";

export interface HealthSample {
  /** The video the player has loaded, or null if there is no player yet. */
  videoId: string | null;
  adShowing: boolean;
  /** Our track is in the player's caption track list. */
  inTracklist: boolean;
  /** Our track is the selected caption track and captions are on. */
  selected: boolean;
  /** How many times the player requested our track for this video. */
  served: number;
  /** How long a reload we asked for has gone without a request (0 if none is pending). */
  reloadWaitMs: number;
  /** Events the player has loaded (the last ones served) that should be on screen now. */
  expected: readonly Json3Event[];
  /** Caption text YouTube's renderer shows right now. */
  shown: string;
}

export interface HealthVerdict {
  mode: TrackMode;
  reason: string;
}

export const HEALTH_LIMITS = {
  /** Our track must appear in the track list this soon after the video loads. */
  tracklistMs: 8000,
  /** After it is selected, the player must request it this soon. */
  requestMs: 6000,
  /**
   * Samples in a row (no caption confirmed on screen in between) in which a caption we
   * served was missing from the screen; a reload can blank it for a sample or two. Samples
   * with nothing to check (gaps between captions) neither count nor reset.
   */
  renderMisses: 6,
};

/**
 * Decides per video whether the CC-menu track works. Once a video falls back to the
 * overlay it stays there (no flapping); the next video starts over.
 */
export class TrackHealth {
  private videoId: string | null = null;
  private since = 0;
  private selectedSince: number | null = null;
  private misses = 0;
  private verdict: HealthVerdict = { mode: "pending", reason: "" };

  constructor(private readonly limits = HEALTH_LIMITS) {}

  /** The verdict for `videoId` so far ("pending" for a video not observed yet). */
  modeFor(videoId: string | null): TrackMode {
    return videoId !== null && videoId === this.videoId ? this.verdict.mode : "pending";
  }

  observe(sample: HealthSample, now: number): HealthVerdict {
    if (sample.videoId !== this.videoId) {
      this.videoId = sample.videoId;
      this.since = now;
      this.selectedSince = null;
      this.misses = 0;
      this.verdict = { mode: "pending", reason: "" };
    }
    if (!sample.videoId || this.verdict.mode === "overlay") return this.verdict;
    if (sample.adShowing) {
      // Ads have their own player state: restart the clocks after them.
      this.since = now;
      this.selectedSince = null;
      this.misses = 0;
      return this.verdict;
    }
    if (!sample.inTracklist) {
      if (this.verdict.mode === "cc") {
        return this.fail("AI 字幕軌從字幕選單消失了");
      }
      return now - this.since >= this.limits.tracklistMs
        ? this.fail("字幕選單裡沒有出現 AI 字幕軌")
        : this.verdict;
    }
    if (!sample.selected) {
      this.selectedSince = null;
      this.misses = 0;
      return this.set("cc", "");
    }
    this.selectedSince ??= now;
    if (sample.served === 0) {
      return now - this.selectedSince >= this.limits.requestMs
        ? this.fail("播放器沒有載入 AI 字幕軌")
        : this.set("cc", "");
    }
    if (sample.reloadWaitMs >= this.limits.requestMs) {
      return this.fail("播放器沒有重新載入 AI 字幕軌");
    }
    if (sample.expected.length) {
      if (showsAnyOf(sample.shown, sample.expected)) {
        this.misses = 0;
      } else if (++this.misses >= this.limits.renderMisses) {
        return this.fail("YouTube 沒有顯示 AI 字幕");
      }
    }
    return this.set("cc", "");
  }

  private set(mode: TrackMode, reason: string): HealthVerdict {
    if (this.verdict.mode !== mode || this.verdict.reason !== reason) {
      this.verdict = { mode, reason };
    }
    return this.verdict;
  }

  private fail(reason: string): HealthVerdict {
    return this.set("overlay", reason);
  }
}
