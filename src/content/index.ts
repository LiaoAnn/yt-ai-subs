// Content script: runs in the isolated world at document_start. Collects the audio the
// page script copies, decides which chunk to transcribe next (a little ahead of the
// playhead), sends it to the background, and draws the captions.
import type { Cue } from "@/shared/captions";
import { LOG_PREFIX } from "@/shared/log";
import {
  isPageMessage,
  type DisplayModeReply,
  type RuntimeMessage,
  type SegmentMessage,
  type TranscribeReply,
  type TranslateReply,
} from "@/shared/messages";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  withDefaults,
  type Settings,
} from "@/shared/settings";
import { videoIdFromUrl } from "@/shared/youtube";
import { AudioStore } from "./audio-store";
import { cacheKey, loadCache, saveCache } from "./cache";
import { CaptionTrackBridge } from "./caption-track";
import { Overlay } from "./overlay";
import {
  DEFAULT_SCHEDULE,
  isFinished,
  isIrrelevant,
  nextNeeded,
  trimCutSentence,
  type Job,
} from "./schedule";
import { buildWav, bytesToBase64 } from "./wav";

console.log(LOG_PREFIX, "content script loaded (isolated world)", document.readyState);

const MAX_PARALLEL_JOBS = 2;
const RETRY_BASE_MS = 8000;
/** How long a range with no buffered audio is skipped before it is checked again. */
const SKIP_RECHECK_MS = 5000;
/** Seconds of earlier captions given as context to Whisper and the translator. */
const CONTEXT_SECONDS = 30;
const CONTEXT_LINES = 4;
const TICK_MS = 1000;
const RENDER_MS = 150;
const DEBUG_LOG_MS = 10_000;

interface JobRecord extends Job {
  id: number;
  controller: AbortController | null;
  /** Translation failed: shown in the original, and not cached. */
  untranslated: boolean;
}

interface VideoState {
  videoId: string;
  store: AudioStore;
  /** Captions state below is reset when the cache key (settings) changes. */
  cacheKey: string | null;
  cacheLoaded: boolean;
  jobs: Map<number, JobRecord>;
  cues: Cue[];
  lastError: string;
}

let settings: Settings = DEFAULT_SETTINGS;
let settingsLoaded = false;
let state: VideoState | null = null;
let nextJobId = 1;
const overlay = new Overlay();
const captionTrack = new CaptionTrackBridge();
const diag = { pageReady: false, audioBuffers: 0, segments: 0, reason: "" };

loadSettings().then(
  (loaded) => {
    settings = loaded;
    settingsLoaded = true;
    captionTrack.writeConfig(settings);
  },
  (error: unknown) => console.warn(LOG_PREFIX, "could not load settings", error),
);
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[SETTINGS_STORAGE_KEY];
  if (area !== "local" || !change) return;
  settings = withDefaults(change.newValue);
  settingsLoaded = true;
  captionTrack.writeConfig(settings);
  tick();
});

const player = () => document.getElementById("movie_player");
const video = () =>
  document.querySelector<HTMLVideoElement>("#movie_player video") ??
  document.querySelector<HTMLVideoElement>("video");
const isAdShowing = () => player()?.classList.contains("ad-showing") ?? false;

function newVideoState(videoId: string): VideoState {
  return {
    videoId,
    store: new AudioStore(),
    cacheKey: null,
    cacheLoaded: false,
    jobs: new Map(),
    cues: [],
    lastError: "",
  };
}

// ---------- audio from the page script ----------

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isPageMessage(event.data)) return;
  const message = event.data;
  if (message.type === "page-ready") {
    diag.pageReady = true;
    console.log(LOG_PREFIX, "content script got page message: page-ready");
  } else if (message.type === "caption-mode") {
    captionTrack.onVerdict(message);
  } else if (message.type === "audio-buffer") {
    diag.audioBuffers++;
    console.log(LOG_PREFIX, "audio SourceBuffer:", message.mime);
  } else {
    onSegment(message);
  }
});

function onSegment(message: SegmentMessage) {
  diag.segments++;
  if (diag.segments === 1) console.log(LOG_PREFIX, "receiving audio");
  const videoId = message.videoId ?? videoIdFromUrl(location.href);
  if (!videoId) return;
  if (!state || state.videoId !== videoId) {
    if (state) abortAll(state);
    state = newVideoState(videoId);
  }
  state.store.append(
    message.bufferId,
    new Uint8Array(message.bytes),
    message.init,
    message.start,
    message.end,
  );
}

// ---------- captions state and cache ----------

function abortAll(target: VideoState) {
  const ids: string[] = [];
  for (const job of target.jobs.values()) {
    if (job.controller && !job.controller.signal.aborted) {
      job.controller.abort();
      ids.push(...requestIds(target, job));
    }
  }
  if (ids.length) cancelRequests(ids);
}

function requestIds(target: VideoState, job: JobRecord) {
  return [`${target.videoId}:${job.id}:asr`, `${target.videoId}:${job.id}:tr`];
}

function cancelRequests(ids: string[]) {
  const message: RuntimeMessage = { type: "cancel", requestIds: ids };
  chrome.runtime.sendMessage(message).catch(() => {
    // The service worker restarted: the requests are gone anyway.
  });
}

/** Resets captions when the settings that shape them change, then loads the cache. */
function syncCacheKey(target: VideoState) {
  const key = cacheKey(target.videoId, settings);
  if (target.cacheKey === key) return;
  abortAll(target);
  target.cacheKey = key;
  target.cacheLoaded = false;
  target.jobs.clear();
  target.cues = [];
  target.lastError = "";
  overlay.clear();
  loadCache(key).then(
    (entry) => {
      if (state !== target || target.cacheKey !== key) return;
      if (entry) {
        for (const chunk of entry.chunks) {
          const id = nextJobId++;
          target.jobs.set(id, {
            id,
            start: chunk.start,
            end: chunk.end,
            status: "done",
            tries: 0,
            retryAt: 0,
            controller: null,
            untranslated: false,
          });
        }
        target.cues.push(...entry.cues);
        target.cues = target.cues.toSorted((a, b) => a.start - b.start);
        console.log(
          LOG_PREFIX,
          `cache hit: ${entry.chunks.length} chunks, ${entry.cues.length} cues`,
        );
      }
      target.cacheLoaded = true;
    },
    (error: unknown) => {
      console.warn(LOG_PREFIX, "could not read the cache", error);
      target.cacheLoaded = true;
    },
  );
}

function persist(target: VideoState) {
  if (!target.cacheKey) return;
  const done = [...target.jobs.values()].filter((job) => job.status === "done");
  const skipped = done.filter((job) => job.untranslated);
  const inSkipped = (cue: Cue) =>
    skipped.some((job) => cue.start >= job.start && cue.start < job.end);
  saveCache(target.cacheKey, {
    chunks: done.filter((job) => !job.untranslated).map(({ start, end }) => ({ start, end })),
    cues: target.cues.filter((cue) => !inSkipped(cue)),
    savedAt: Date.now(),
  }).catch((error: unknown) => console.warn(LOG_PREFIX, "could not save the cache", error));
}

// ---------- jobs ----------

/** Jobs with a request or decode in progress. */
const inFlight = (target: VideoState) =>
  [...target.jobs.values()].filter((job) => job.controller !== null).length;

async function runJob(target: VideoState, job: JobRecord, videoDuration: number) {
  const controller = new AbortController();
  const { signal } = controller;
  job.controller = controller;
  job.status = "running";
  const [asrId, trId] = requestIds(target, job);
  const label = `${job.start.toFixed(1)}–${job.end.toFixed(1)} s`;
  try {
    const audio = await buildWav(target.store, job.start, job.end, signal);
    if (!audio) {
      target.jobs.delete(job.id); // not buffered yet; schedule again later
      return;
    }
    const previous = target.cues
      .filter((cue) => cue.end <= job.start + 0.5 && cue.end > job.start - CONTEXT_SECONDS)
      .slice(-CONTEXT_LINES);
    const asrRequest: RuntimeMessage = {
      type: "transcribe",
      requestId: asrId!,
      wavBase64: bytesToBase64(audio.wav),
      durationSeconds: audio.duration,
      context: previous.map((cue) => cue.original).join(" "),
    };
    signal.throwIfAborted(); // a seek during decoding: send nothing
    const asr = (await chrome.runtime.sendMessage(asrRequest)) as TranscribeReply | undefined;
    if (signal.aborted || state !== target) return;
    if (!asr) throw new Error("背景程式沒有回應");
    if (!asr.ok) throw new Error(asr.error);
    console.log(
      LOG_PREFIX,
      `whisper ${label} (${audio.duration.toFixed(1)} s audio): ${asr.latencyMs} ms` +
        (asr.waitedMs ? `, waited ${asr.waitedMs} ms for the rate limit` : "") +
        `, ${asr.cues.length} lines`,
    );

    const atVideoEnd = job.end >= videoDuration - 0.5;
    const nextClaimed = [...target.jobs.values()].some(
      (other) => other !== job && other.status !== "error" && Math.abs(other.start - job.end) < 0.3,
    );
    let relative = asr.cues;
    const trimmed = trimCutSentence(relative, audio.duration, !atVideoEnd && !nextClaimed);
    if (trimmed) {
      relative = trimmed.cues;
      job.end = Math.round((job.start + trimmed.newLength) * 100) / 100;
    }
    const fresh: Cue[] = [];
    for (const cue of relative) {
      const start = job.start + cue.start;
      const end = Math.min(job.start + cue.end, job.end + 1);
      if (end > start) fresh.push({ start, end, original: cue.original });
    }
    // Show the original right away; the translation replaces it when it arrives.
    target.cues.push(...fresh);
    target.cues = target.cues.toSorted((a, b) => a.start - b.start);

    if (settings.translate && fresh.length) {
      const trRequest: RuntimeMessage = {
        type: "translate",
        requestId: trId!,
        lines: fresh.map((cue) => cue.original),
        context: previous.map((cue) => cue.translation ?? cue.original).join("\n"),
      };
      const tr = (await chrome.runtime.sendMessage(trRequest)) as TranslateReply | undefined;
      if (signal.aborted || state !== target) {
        target.cues = target.cues.filter((cue) => !fresh.includes(cue));
        return;
      }
      if (tr?.ok) {
        fresh.forEach((cue, i) => {
          cue.translation = tr.lines[i] ?? cue.original;
        });
        target.lastError = "";
        console.log(
          LOG_PREFIX,
          `translation ${label}: ${fresh.length} lines, ${tr.totalTokens} tokens, ${tr.latencyMs} ms` +
            (tr.waitedMs ? `, waited ${tr.waitedMs} ms for the rate limit` : ""),
        );
      } else {
        job.untranslated = true;
        target.lastError = tr ? tr.error : "翻譯沒有回應";
        console.warn(LOG_PREFIX, `translation ${label} failed:`, target.lastError);
      }
    } else {
      target.lastError = "";
    }
    job.status = "done";
    persist(target);
  } catch (error) {
    if (signal.aborted || state !== target) return;
    job.status = "error";
    job.tries++;
    job.retryAt = Date.now() + RETRY_BASE_MS * job.tries;
    target.lastError = error instanceof Error ? error.message : String(error);
    console.warn(LOG_PREFIX, `chunk ${label} failed:`, target.lastError);
  } finally {
    job.controller = null;
    if (signal.aborted && job.status === "running") target.jobs.delete(job.id);
  }
}

/** Cancels running jobs a seek made irrelevant. */
function cancelIrrelevant(target: VideoState, t: number) {
  const ids: string[] = [];
  for (const job of target.jobs.values()) {
    if (job.status !== "running" || !job.controller || !isIrrelevant(job, t)) continue;
    console.log(
      LOG_PREFIX,
      `cancel ${job.start.toFixed(1)}–${job.end.toFixed(1)} s (playhead ${t.toFixed(1)} s)`,
    );
    job.controller.abort();
    ids.push(...requestIds(target, job));
    // Forget it now, so neither the scheduler nor pruning treats the range as handled.
    target.jobs.delete(job.id);
  }
  if (ids.length) cancelRequests(ids);
}

function schedule(target: VideoState, v: HTMLVideoElement) {
  const t = v.currentTime;
  const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
  cancelIrrelevant(target, t);
  for (let guard = 0; inFlight(target) < MAX_PARALLEL_JOBS && guard < 4; guard++) {
    const next = nextNeeded([...target.jobs.values()], t, duration, Date.now(), DEFAULT_SCHEDULE);
    if (!next) {
      diag.reason = inFlight(target) ? "處理中" : "前面都處理好了";
      break;
    }
    const job: JobRecord = next.retry
      ? (next.retry as JobRecord)
      : {
          id: nextJobId++,
          start: next.start,
          end: next.end,
          status: "running",
          tries: 0,
          retryAt: 0,
          controller: null,
          untranslated: false,
        };
    const readiness = target.store.readiness(job.start, Math.min(job.end, duration));
    if (readiness === "never") {
      // The buffer jumped past this part (e.g. a seek): don't block on it, but look again
      // later, since seeking back makes YouTube buffer it after all. Not a failed try.
      target.jobs.set(job.id, { ...job, status: "error", retryAt: Date.now() + SKIP_RECHECK_MS });
      diag.reason = `跳過 ${job.start.toFixed(1)}–${job.end.toFixed(1)} 秒（沒有音訊）`;
      continue;
    }
    if (readiness === "wait") {
      // Playback is catching up: send what is already buffered instead of waiting.
      const head = target.store
        .coverage(job.start, job.end)
        .runs.find((run) => run.start <= job.start + 0.3);
      const have = head ? Math.min(head.end, job.end) - job.start : 0;
      if (job.start - t < 12 && have >= 5) {
        job.end = Math.round((job.start + have - 0.1) * 100) / 100;
      } else {
        diag.reason = `音訊還沒涵蓋 ${job.start.toFixed(1)}–${job.end.toFixed(1)} 秒`;
        break;
      }
    }
    target.jobs.set(job.id, job);
    diag.reason = `送出 ${job.start.toFixed(1)}–${job.end.toFixed(1)} 秒`;
    void runJob(target, job, duration);
  }
  target.store.prune(t, (time) => isFinished(target.jobs.values(), time));
}

// ---------- main loop ----------

function currentState(): VideoState | null {
  return state && state.videoId === videoIdFromUrl(location.href) ? state : null;
}

let playingSince = 0;
function updateStatus(target: VideoState | null, v: HTMLVideoElement | null) {
  if (v && !v.paused) playingSince ||= Date.now();
  else playingSince = 0;
  const playedLong = playingSince > 0 && Date.now() - playingSince > 6000;
  const t = v?.currentTime ?? 0;
  const onScreen = target?.cues.some((cue) => cue.start <= t + 1 && cue.end > t - 5) ?? false;
  let message = "";
  if (!settings.enabled || isAdShowing() || !settingsLoaded) message = "";
  else if (!settings.groqApiKey) message = "AI 字幕：請點擴充圖示填 Groq API key";
  else if (target?.lastError) message = `AI 字幕：${target.lastError}`;
  else if (!diag.pageReady && playedLong) message = "AI 字幕：沒掛上播放器，請重新整理頁面";
  else if (!target && playedLong) {
    message = diag.audioBuffers
      ? "AI 字幕：有找到音訊但沒收到資料"
      : "AI 字幕：找不到音訊，請重新整理頁面";
  } else if (target && !onScreen && (inFlight(target) || playedLong)) {
    message = inFlight(target) ? "AI 字幕：聽寫中…" : "AI 字幕：等待音訊…";
  }
  overlay.setStatus(message);
}

function tick() {
  const target = currentState();
  const v = video();
  updateStatus(target, v);
  if (target && settingsLoaded) captionTrack.sync(target.videoId, target.cues, settings);
  if (!target) {
    diag.reason = "還沒收到這支影片的音訊";
    return;
  }
  if (!settingsLoaded) return;
  if (!settings.enabled) {
    abortAll(target);
    diag.reason = "已關閉";
    return;
  }
  syncCacheKey(target);
  if (!target.cacheLoaded) {
    diag.reason = "讀取快取中";
    return;
  }
  if (!settings.groqApiKey) {
    diag.reason = "沒有 API key";
    return;
  }
  if (!v || !player()) {
    diag.reason = "找不到 video 元素";
    return;
  }
  if (isAdShowing()) {
    diag.reason = "廣告中";
    return;
  }
  schedule(target, v);
}

// Time from a start or seek until a caption is on screen; logged once per start or seek
// (a "playing" after a buffering stall does not restart it).
let waitingSince = 0;
let firstCaptionLogged = false;
function render() {
  const target = currentState();
  const v = video();
  if (!target || !v || !settings.enabled || isAdShowing()) {
    overlay.clear();
    return;
  }
  // Captions go to YouTube's CC menu; the overlay is only the fallback when that breaks.
  if (captionTrack.mode(target.videoId).mode === "overlay") {
    overlay.render(target.cues, v.currentTime, settings.showOriginal);
  } else {
    overlay.clear();
  }
  if (
    waitingSince &&
    target.cues.some((cue) => cue.start <= v.currentTime && cue.end > v.currentTime)
  ) {
    console.log(LOG_PREFIX, `first caption ${Date.now() - waitingSince} ms after play/seek`);
    waitingSince = 0;
    firstCaptionLogged = true;
  }
}

document.addEventListener(
  "playing",
  (event) => {
    if (event.target === video() && !waitingSince && !firstCaptionLogged) {
      waitingSince = Date.now();
    }
  },
  true,
);
document.addEventListener(
  "seeking",
  (event) => {
    if (event.target !== video()) return;
    waitingSince = Date.now();
    firstCaptionLogged = false;
    tick();
  },
  true,
);

let lastDebug = 0;
function debugLog() {
  if (Date.now() - lastDebug < DEBUG_LOG_MS) return;
  lastDebug = Date.now();
  const v = video();
  const target = currentState();
  if (!target && !diag.segments) return;
  console.log(
    LOG_PREFIX,
    "state",
    JSON.stringify({
      t: v ? Number(v.currentTime.toFixed(1)) : null,
      segments: diag.segments,
      clusters: target?.store.clusters.size ?? 0,
      audio: target?.store.describe() ?? [],
      inFlight: target ? inFlight(target) : 0,
      cues: target?.cues.length ?? 0,
      error: target?.lastError ?? "",
      reason: diag.reason,
    }),
  );
}

setInterval(() => {
  tick();
  debugLog();
}, TICK_MS);
setInterval(render, RENDER_MS);

// The popup asks which display mode this tab uses.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== "get-display-mode") return false;
  const reply: DisplayModeReply = settings.enabled
    ? captionTrack.mode(videoIdFromUrl(location.href))
    : { videoId: videoIdFromUrl(location.href), mode: "pending", reason: "" };
  sendResponse(reply);
  return false;
});

chrome.runtime.sendMessage({ type: "ping" } satisfies RuntimeMessage).then(
  (reply: unknown) => console.log(LOG_PREFIX, "background replied:", reply),
  (error: unknown) => console.warn(LOG_PREFIX, "background did not reply:", error),
);
