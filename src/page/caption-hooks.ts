// Browser glue for the AI caption track in YouTube's caption (CC) menu (MAIN world).
// The logic is in caption-track.ts; the how and the fragile parts are described in
// .claude/skills/debug-caption-track/SKILL.md.

import type { Json3, Json3Event } from "@/shared/captions";
import { LOG_PREFIX } from "@/shared/log";
import {
  PAGE_MESSAGE_TAG,
  isPageCommand,
  type CaptionModeMessage,
  type DisplayMode,
} from "@/shared/messages";
import { TRACK_CONFIG_STORAGE_KEY, parseTrackConfig } from "@/shared/track-config";
import {
  creatorMessage,
  creatorTick,
  installCreatorCaptions,
  noteResponse,
  noteTimedtextUrl,
  targetFor,
} from "./creator-hooks";
import {
  TrackHealth,
  activeEvents,
  isOurVssId,
  isPlayerEndpoint,
  liveStatus,
  ourTrackVideoId,
  patchPlayerResponse,
  playerResponsesIn,
  shouldReloadNow,
} from "./caption-track";

/** The parts of YouTube's player element (#movie_player) used here. */
interface YtPlayer extends HTMLElement {
  getVideoData?: () => { video_id?: string } | undefined;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  getCurrentTime?: () => number;
  getPlayerState?: () => number;
}

interface PlayerTrack {
  vss_id?: string;
  languageCode?: string;
}

const CONTROL_MS = 500;
const REPOST_MS = 5000;
const DEBUG_LOG_MS = 10_000;
/** Ask the player to reload again if it did not request the track this soon. */
const RELOAD_RETRY_MS = 2000;

function retryReload(player: YtPlayer) {
  try {
    player.setOption?.("captions", "reload", true);
  } catch (error) {
    console.warn(LOG_PREFIX, "could not reload the caption track", error);
  }
}
/** Keep the events of this many videos (the current one plus a few back/forward). */
const MAX_VIDEOS = 4;

interface VideoTrack {
  events: Json3Event[];
  /** Bumped on every update from the content script. */
  version: number;
  /** The version the player last requested, and the events it got. */
  servedVersion: number;
  served: Json3Event[];
  requests: number;
  /** When we last asked the player to reload the track and it has not requested it since. */
  reloadAskedAt: number | null;
}

const tracks = new Map<string, VideoTrack>();

function trackFor(videoId: string): VideoTrack {
  let track = tracks.get(videoId);
  if (!track) {
    track = {
      events: [],
      version: 0,
      servedVersion: -1,
      served: [],
      requests: 0,
      reloadAskedAt: null,
    };
    tracks.set(videoId, track);
    while (tracks.size > MAX_VIDEOS) tracks.delete(tracks.keys().next().value!);
  }
  return track;
}

function readConfig() {
  try {
    return parseTrackConfig(localStorage.getItem(TRACK_CONFIG_STORAGE_KEY));
  } catch {
    return parseTrackConfig(null);
  }
}

/** Live streams seen in player responses (they get no track and no captions). */
const liveVideos = new Set<string>();

/** Adds our track to a player response; true if it changed it. */
function patch(response: unknown): boolean {
  try {
    const status = liveStatus(response);
    // A stream that ended (watched again as a recording) is an ordinary video again.
    if (status?.live) liveVideos.add(status.videoId);
    else if (status) liveVideos.delete(status.videoId);
    const config = readConfig();
    // The creator's own track in our language replaces ours (creator-hooks.ts).
    if (noteResponse(response, config)) return false;
    const videoId = patchPlayerResponse(response, config);
    if (videoId) console.log(LOG_PREFIX, "caption track added to the player response", videoId);
    return videoId !== null;
  } catch (error) {
    console.warn(LOG_PREFIX, "could not add the caption track", error);
    return false;
  }
}

/** The json3 body for a request of our track; records it as served. */
function serve(videoId: string): string {
  const track = trackFor(videoId);
  track.requests++;
  track.servedVersion = track.version;
  track.served = track.events;
  track.reloadAskedAt = null;
  console.log(LOG_PREFIX, `caption track served: ${track.events.length} events for ${videoId}`);
  const body: Json3 = { wireMagic: "pb3", events: track.events };
  return JSON.stringify(body);
}

// ---------- 1. player responses ----------

/** The first page load assigns `var ytInitialPlayerResponse = {...}` in an inline script. */
function hookInitialPlayerResponse() {
  let value: unknown = (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
  if (value !== undefined) patch(value);
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next: unknown) => {
        patch(next);
        value = next;
      },
    });
  } catch (error) {
    console.warn(LOG_PREFIX, "could not hook ytInitialPlayerResponse", error);
  }
}

const requestUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** SPA navigations fetch the player response from /youtubei/v1/get_watch or /player. */
function hookFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let url = "";
    try {
      url = requestUrl(input);
    } catch {
      // fall through to the real fetch
    }
    if (url) noteTimedtextUrl(url);
    const videoId = url ? ourTrackVideoId(url) : null;
    if (videoId) {
      return new Response(serve(videoId), {
        status: 200,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
    const response = await originalFetch.call(this, input, init);
    if (!isPlayerEndpoint(url) || !response.ok) return response;
    try {
      const body: unknown = await response.clone().json();
      let changed = false;
      for (const playerResponse of playerResponsesIn(body))
        changed = patch(playerResponse) || changed;
      if (!changed) return response;
      const text = JSON.stringify(body);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      const patched = new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      Object.defineProperty(patched, "url", { value: response.url });
      return patched;
    } catch {
      return response;
    }
  } as typeof window.fetch;
}

// ---------- 2. timedtext requests for our track ----------

const FAKE = Symbol("yt-ai-subs.fake-xhr");
const ABORTED = Symbol("yt-ai-subs.fake-xhr-aborted");

type FakeXhr = XMLHttpRequest & { [FAKE]?: string | undefined; [ABORTED]?: boolean };

/** Completes a request for our track as if YouTube had answered it with `text`. */
function answer(xhr: FakeXhr, text: string) {
  if (xhr[ABORTED]) return;
  const responseType = xhr.responseType;
  const response =
    responseType === "json"
      ? JSON.parse(text)
      : responseType === "arraybuffer"
        ? new TextEncoder().encode(text).buffer
        : responseType === "blob"
          ? new Blob([text], { type: "application/json" })
          : text;
  const own = (name: string, value: unknown) =>
    Object.defineProperty(xhr, name, { configurable: true, value });
  own("readyState", 4);
  own("status", 200);
  own("statusText", "OK");
  own("responseURL", "https://www.youtube.com/api/timedtext");
  own("response", response);
  if (responseType === "" || responseType === "text") own("responseText", text);
  own("getResponseHeader", (name: string) =>
    name.toLowerCase() === "content-type" ? "application/json; charset=UTF-8" : null,
  );
  own("getAllResponseHeaders", () => "content-type: application/json; charset=UTF-8\r\n");
  xhr.dispatchEvent(new Event("readystatechange"));
  for (const type of ["load", "loadend"]) {
    xhr.dispatchEvent(
      new ProgressEvent(type, { lengthComputable: true, loaded: text.length, total: text.length }),
    );
  }
}

/** The player loads caption tracks with XMLHttpRequest; answer ours without a request. */
function hookXhr() {
  const proto = XMLHttpRequest.prototype as FakeXhr;
  const open = proto.open;
  const send = proto.send;
  const abort = proto.abort;
  proto.open = function (this: FakeXhr, ...args: [string, string | URL, ...unknown[]]) {
    let videoId: string | null = null;
    try {
      noteTimedtextUrl(String(args[1]));
      videoId = ourTrackVideoId(String(args[1]));
    } catch {
      videoId = null;
    }
    this[FAKE] = videoId ?? undefined;
    this[ABORTED] = false;
    return (open as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.open;
  proto.abort = function (this: FakeXhr) {
    this[ABORTED] = true;
    return abort.call(this);
  };
  proto.send = function (this: FakeXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const videoId = this[FAKE];
    if (!videoId) return send.call(this, body);
    const text = serve(videoId);
    setTimeout(() => answer(this, text), 0);
  } as typeof proto.send;
}

// ---------- 3. cues from the content script ----------

function listenForCues() {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!isPageCommand(event.data)) return;
    if (event.data.type === "get-creator-captions") {
      window.postMessage(creatorMessage(event.data.videoId), location.origin);
      return;
    }
    const track = trackFor(event.data.videoId);
    track.events = event.data.events;
    track.version++;
  });
}

// ---------- 4. selecting, reloading and checking the track ----------

function post(message: Omit<CaptionModeMessage, typeof PAGE_MESSAGE_TAG>) {
  window.postMessage({ [PAGE_MESSAGE_TAG]: true, ...message }, location.origin);
}

function control() {
  const health = new TrackHealth();
  const autoSelected = new Set<string>();
  let staleSince = 0;
  let lastPosted = "";
  let lastPostedAt = 0;
  let lastDebug = 0;
  let lastReloadCall = 0;

  setInterval(() => {
    const player = document.getElementById("movie_player") as YtPlayer | null;
    let videoId: string | null = null;
    let inTracklist = false;
    let selected = false;
    let adShowing = false;
    let ours: PlayerTrack | undefined;
    let t = 0;
    try {
      if (player?.getVideoData && player.getOption) {
        videoId = player.getVideoData()?.video_id || null;
        adShowing = player.classList.contains("ad-showing");
        const list = player.getOption("captions", "tracklist");
        ours = Array.isArray(list)
          ? (list as PlayerTrack[]).find((track) => isOurVssId(track?.vss_id))
          : undefined;
        inTracklist = !!ours;
        const current = player.getOption("captions", "track") as PlayerTrack | undefined;
        selected = inTracklist && isOurVssId(current?.vss_id);
        t = player.getCurrentTime?.() ?? 0;
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "caption track: player API failed", error);
    }

    const config = readConfig();
    const track = videoId ? trackFor(videoId) : null;
    if (config.enabled) creatorTick(player, videoId, adShowing, CONTROL_MS);
    const creatorTarget = targetFor(videoId);

    // Never select the track for a video that already fell back to the overlay (the track
    // can show up late): the captions would be shown twice.
    const fellBack = health.modeFor(videoId) === "overlay";
    if (
      player &&
      videoId &&
      ours &&
      config.enabled &&
      !adShowing &&
      !fellBack &&
      !autoSelected.has(videoId)
    ) {
      autoSelected.add(videoId);
      if (!selected) {
        try {
          player.setOption?.("captions", "track", ours);
          console.log(LOG_PREFIX, "caption track selected", videoId);
        } catch (error) {
          console.warn(LOG_PREFIX, "could not select the caption track", error);
        }
      }
    }

    const segments = player?.querySelectorAll(".ytp-caption-segment") ?? [];
    const shown = [...segments].map((segment) => segment.textContent ?? "").join("\n");

    if (player && track && selected && track.requests > 0) {
      if (track.version !== track.servedVersion) staleSince ||= Date.now();
      else staleSince = 0;
      const paused = player.getPlayerState?.() !== 1;
      if (
        shouldReloadNow({
          now: Date.now(),
          staleSince,
          captionShowing: shown.trim().length > 0,
          paused,
        })
      ) {
        // Ask again only if the last reload did not lead to a request; the health check
        // falls back if requests stop coming.
        const now = Date.now();
        if (now - lastReloadCall >= RELOAD_RETRY_MS) {
          lastReloadCall = now;
          track.reloadAskedAt ??= now;
          retryReload(player);
        }
      }
    } else {
      staleSince = 0;
      // Not selected (or never loaded): nothing is owed; a new selection makes a request.
      if (track) track.reloadAskedAt = null;
    }

    const sample = {
      videoId,
      adShowing,
      inTracklist,
      selected,
      served: track?.requests ?? 0,
      reloadWaitMs: track?.reloadAskedAt != null ? Date.now() - track.reloadAskedAt : 0,
      expected: track && selected ? activeEvents(track.served, t) : [],
      shown,
    };
    const verdict: { mode: DisplayMode; reason: string } = !config.enabled
      ? { mode: "overlay", reason: "AI 字幕已關閉" }
      : creatorTarget
        ? { mode: "creator", reason: creatorTarget.name || creatorTarget.languageCode }
        : health.observe(sample, Date.now());
    if (Date.now() - lastDebug >= DEBUG_LOG_MS && videoId) {
      lastDebug = Date.now();
      console.log(
        LOG_PREFIX,
        "caption track",
        JSON.stringify({
          ...sample,
          t: Number(t.toFixed(1)),
          expected: sample.expected.length,
          shown: shown.slice(0, 40),
          events: track?.events.length ?? 0,
          version: track?.version ?? 0,
          servedVersion: track?.servedVersion ?? 0,
          ...verdict,
        }),
      );
    }
    const live = videoId !== null && liveVideos.has(videoId);
    const key = JSON.stringify([videoId, verdict.mode, verdict.reason, live]);
    // Repeat now and then, in case the content script missed it (it loads after us).
    if (key !== lastPosted || Date.now() - lastPostedAt > REPOST_MS) {
      const changed = key !== lastPosted;
      lastPosted = key;
      lastPostedAt = Date.now();
      if (changed && verdict.mode === "overlay" && config.enabled) {
        console.warn(LOG_PREFIX, "caption track: falling back to the overlay:", verdict.reason);
        // If YouTube does show the track after all, don't show the captions twice.
        if (selected) {
          try {
            player?.setOption?.("captions", "track", {});
          } catch {
            // nothing more to do
          }
        }
      }
      post({ type: "caption-mode", videoId, mode: verdict.mode, reason: verdict.reason, live });
    }
  }, CONTROL_MS);
}

export function installCaptionTrack() {
  installCreatorCaptions();
  hookInitialPlayerResponse();
  hookFetch();
  hookXhr();
  listenForCues();
  control();
}
