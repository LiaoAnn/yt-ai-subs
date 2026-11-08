// Content script: runs in the isolated world at document_start. Collects the audio the
// page script copies, decides which chunk to transcribe next (a little ahead of the
// playhead), sends it to the background, and draws the captions.
import type { Cue } from "@/shared/captions";
import { LOG_PREFIX } from "@/shared/log";
import {
  isPageMessage,
  type DisplayModeReply,
  type QuotaReply,
  type RuntimeMessage,
  type SegmentMessage,
  type TranscribeReply,
  type TranslateReply,
} from "@/shared/messages";
import { TRANSLATION_PAUSED_MESSAGE, translationPaused, type QuotaLevels } from "@/shared/quota";
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
import { saveDebugCapture } from "./debug-capture";
import { energyEnvelope, findQuietCut, isNearFloor } from "./energy";
import { Overlay } from "./overlay";
import {
  DEFAULT_SCHEDULE,
  isFinished,
  isIrrelevant,
  nextNeeded,
  trimCutSentence,
  type Job,
} from "./schedule";
import { MIN_VOICED_SHARE, bestVoicedWindow, voiceFeatures } from "./voice";
import { WAV_SAMPLE_RATE, bytesToBase64, encodeWav, renderAudio } from "./wav";

console.log(LOG_PREFIX, "content script loaded (isolated world)", document.readyState);

const MAX_PARALLEL_JOBS = 2;
/** How often the day's Groq budget is asked for (it also comes with every reply). */
const QUOTA_REFRESH_MS = 30_000;
/** With little of the day's Whisper budget left: one chunk at a time, less far ahead. */
const LOW_QUOTA_SCHEDULE = { ...DEFAULT_SCHEDULE, lookaheadSeconds: 30 };
const RETRY_BASE_MS = 8000;
/** How long a range with no buffered audio is skipped before it is checked again. */
const SKIP_RECHECK_MS = 5000;
/** Seconds of earlier captions given as context to Whisper and the translator. */
const CONTEXT_SECONDS = 30;
const CONTEXT_LINES = 4;
const TICK_MS = 1000;
const RENDER_MS = 150;
const DEBUG_LOG_MS = 10_000;
/** A flexible chunk end moves to the quietest moment up to this far earlier or later. */
const CUT_EARLIER_SECONDS = 6;
const CUT_LATER_SECONDS = 4;
/** A chunk waits at most this long for the chunk before it, to use it as context. */
const CONTEXT_WAIT_MS = 5000;

/**
 * The running chunk that ends where `job` starts, if any. During a start-up burst the next
 * chunk is decoded while this one is still at Groq; it waits for it, so that its Whisper
 * prompt and translation context are not empty.
 */
function runningPredecessor(target: VideoState, job: JobRecord): JobRecord | undefined {
  for (const other of target.jobs.values()) {
    if (other !== job && other.status === "running" && Math.abs(other.end - job.start) < 0.3) {
      return other;
    }
  }
  return undefined;
}

/** Resolves when `ready()` holds, the signal aborts, or after `timeoutMs`; returns ms waited. */
async function waitUntil(ready: () => boolean, timeoutMs: number, signal: AbortSignal) {
  const since = Date.now();
  while (!ready() && !signal.aborted && Date.now() - since < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Date.now() - since;
}

const recentLines = (target: VideoState, start: number) =>
  target.cues
    .filter((cue) => cue.end <= start + 0.5 && cue.end > start - CONTEXT_SECONDS)
    .slice(-CONTEXT_LINES);

interface JobRecord extends Job {
  id: number;
  controller: AbortController | null;
  /** Translation failed: shown in the original, and not cached. */
  untranslated: boolean;
  /** Its original lines are in (the next chunk can use them as Whisper's prompt). */
  transcribed?: boolean;
}

interface VideoState {
  videoId: string;
  store: AudioStore;
  /** Captions state below is reset when the cache key (settings) changes. */
  cacheKey: string | null;
  cacheLoaded: boolean;
  jobs: Map<number, JobRecord>;
  /** Change cues only through setCues (or bump cuesVersion), so the CC track notices. */
  cues: Cue[];
  /** Bumped on every change to `cues` or their text; the CC track resends on a change. */
  cuesVersion: number;
  lastError: string;
}

function setCues(target: VideoState, cues: Cue[]) {
  target.cues = cues;
  target.cuesVersion++;
}

let settings: Settings = DEFAULT_SETTINGS;
let settingsLoaded = false;
let state: VideoState | null = null;
let nextJobId = 1;
let quota: QuotaLevels = { whisper: "ok", chat: "ok" };
/** Nothing is sent until the background has said how much budget is left. */
let quotaKnown = false;
let quotaAskedAt = 0;

/** Keeps `quota` fresh, so the scheduler notices a budget reset or running low. */
function refreshQuota() {
  if (Date.now() - quotaAskedAt < (quotaKnown ? QUOTA_REFRESH_MS : 2000)) return;
  quotaAskedAt = Date.now();
  chrome.runtime.sendMessage({ type: "get-quota" } satisfies RuntimeMessage).then(
    (reply: QuotaReply | undefined) => {
      if (reply?.type !== "quota") return;
      quota = reply.levels;
      quotaKnown = true;
    },
    () => {
      // The service worker is restarting; ask again next time.
    },
  );
}
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
    cuesVersion: 0,
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
  setCues(target, []);
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
        setCues(
          target,
          target.cues.toSorted((a, b) => a.start - b.start),
        );
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
  let label = `${job.start.toFixed(1)}–${job.end.toFixed(1)} s`;
  try {
    // A flexible end is a target: render a little past it (as far as audio is buffered)
    // and cut at the quietest moment nearby, so no word is split between two chunks.
    const targetLength = job.end - job.start;
    let renderEnd = job.end;
    if (job.flexible) {
      const later = Math.min(CUT_LATER_SECONDS, targetLength * 0.2);
      const head = target.store
        .coverage(job.start, job.end + later)
        .runs.find((run) => run.start <= job.start + 0.3);
      renderEnd = Math.max(job.end, Math.min(job.end + later, (head?.end ?? 0) - 0.05));
    }
    const rendered = await renderAudio(target.store, job.start, renderEnd, signal);
    if (!rendered) {
      target.jobs.delete(job.id); // not buffered yet; schedule again later
      return;
    }
    let duration = rendered.duration;
    let cutDb: number | null = null;
    let cutInPause = false;
    if (job.flexible) {
      const envelope = energyEnvelope(rendered.samples, WAV_SAMPLE_RATE);
      const earlier = Math.min(CUT_EARLIER_SECONDS, targetLength * 0.3);
      const cut = findQuietCut(envelope, targetLength, targetLength - earlier, duration);
      duration = Math.round(cut.time * 100) / 100;
      cutDb = cut.db;
      cutInPause = isNearFloor(envelope, cut.db);
      job.end = Math.round((job.start + duration) * 100) / 100;
      job.flexible = false;
      label = `${job.start.toFixed(1)}–${job.end.toFixed(1)} s`;
      tick(); // the next chunk can be scheduled now
    }
    const samples = rendered.samples.subarray(0, Math.round(duration * WAV_SAMPLE_RATE));
    const audio = { wav: encodeWav(samples, WAV_SAMPLE_RATE), duration, samples };
    // Skip stretches without a voice (background music, silence): they cost money and
    // Whisper makes up text for them.
    const voice = voiceFeatures(samples, WAV_SAMPLE_RATE);
    const voiced = bestVoicedWindow(voice);
    const dryRun = settings.debugCapture && settings.debugDryRun;
    if (voiced < MIN_VOICED_SHARE || dryRun) {
      if (settings.debugCapture) {
        saveDebugCapture(settings, {
          videoId: target.videoId,
          start: job.start,
          end: job.end,
          sentSeconds: dryRun ? duration : 0,
          context: "",
          raw: null,
          envelope: energyEnvelope(samples, WAV_SAMPLE_RATE),
          voice,
          cues: [],
        });
      }
      console.log(
        LOG_PREFIX,
        `${dryRun ? "dry run" : "no voice, skipped"} ${label} (voiced ${Math.round(voiced * 100)}%)`,
      );
      job.status = "done";
      if (!dryRun) persist(target); // a skipped stretch costs nothing when watched again
      return;
    }
    const before = runningPredecessor(target, job);
    let contextWaitMs = 0;
    if (before) {
      contextWaitMs = await waitUntil(
        () => before.transcribed === true || before.status !== "running",
        CONTEXT_WAIT_MS,
        signal,
      );
    }
    const previous = recentLines(target, job.start);
    const asrRequest: RuntimeMessage = {
      type: "transcribe",
      requestId: asrId!,
      videoId: target.videoId,
      wavBase64: bytesToBase64(audio.wav),
      durationSeconds: audio.duration,
      context: previous.map((cue) => cue.original).join(" "),
    };
    signal.throwIfAborted(); // a seek during decoding: send nothing
    if (quota.whisper === "out") {
      // The day's budget ran out while this chunk was decoding: send nothing.
      target.jobs.delete(job.id);
      return;
    }
    const asr = (await chrome.runtime.sendMessage(asrRequest)) as TranscribeReply | undefined;
    if (signal.aborted || state !== target) return;
    if (!asr) throw new Error("背景程式沒有回應");
    if (!asr.ok) throw new Error(asr.error);
    quota = asr.quota;
    console.log(
      LOG_PREFIX,
      `whisper ${label} (${audio.duration.toFixed(1)} s audio` +
        (cutDb === null ? "" : `, cut at ${cutDb} dB${cutInPause ? " (pause)" : ""}`) +
        `, voiced ${Math.round(voiced * 100)}%` +
        `): ${asr.latencyMs} ms` +
        (asr.waitedMs ? `, waited ${asr.waitedMs} ms for the rate limit` : "") +
        (before ? `, waited ${contextWaitMs} ms for the chunk before` : "") +
        `, ${asr.cues.length} lines`,
    );

    // Near the end, a trim would only leave a tiny last request.
    const atVideoEnd = job.end >= videoDuration - DEFAULT_SCHEDULE.minChunkSeconds;
    const nextClaimed = [...target.jobs.values()].some(
      (other) => other !== job && other.status !== "error" && Math.abs(other.start - job.end) < 0.3,
    );
    let relative = asr.cues;
    // A cut in a real pause split no sentence: dropping the last line would only make the
    // next request send it again.
    const trimmed = trimCutSentence(
      relative,
      audio.duration,
      !atVideoEnd && !nextClaimed && !cutInPause,
    );
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
    setCues(
      target,
      target.cues.toSorted((a, b) => a.start - b.start),
    );
    job.transcribed = true;

    if (settings.translate && fresh.length && translationPaused(quota)) {
      // Keep the rest of the day's budget for the original captions.
      job.untranslated = true;
      target.lastError = TRANSLATION_PAUSED_MESSAGE;
    } else if (settings.translate && fresh.length) {
      // Translate with the chunk before already translated, so names and terms carry over.
      if (before) {
        contextWaitMs += await waitUntil(
          () => before.status !== "running",
          CONTEXT_WAIT_MS,
          signal,
        );
        if (signal.aborted || state !== target) {
          // Cancelled while waiting (seek, other video, turned off): send nothing.
          setCues(
            target,
            target.cues.filter((cue) => !fresh.includes(cue)),
          );
          return;
        }
      }
      const trRequest: RuntimeMessage = {
        type: "translate",
        requestId: trId!,
        videoId: target.videoId,
        lines: fresh.map((cue) => cue.original),
        context: recentLines(target, job.start)
          .map((cue) => (cue.translation ? `${cue.original} → ${cue.translation}` : cue.original))
          .join("\n"),
      };
      const tr = (await chrome.runtime.sendMessage(trRequest)) as TranslateReply | undefined;
      if (signal.aborted || state !== target) {
        setCues(
          target,
          target.cues.filter((cue) => !fresh.includes(cue)),
        );
        return;
      }
      if (tr?.ok) quota = tr.quota;
      else if (tr?.quotaPaused)
        quota = { ...quota, chat: quota.chat === "ok" ? "low" : quota.chat };
      if (tr?.ok) {
        fresh.forEach((cue, i) => {
          cue.translation = tr.lines[i] ?? cue.original;
        });
        target.cuesVersion++;
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
    if (settings.debugCapture) {
      saveDebugCapture(settings, {
        videoId: target.videoId,
        start: job.start,
        end: job.end,
        sentSeconds: audio.duration,
        context: asrRequest.context,
        raw: asr.raw ?? null,
        envelope: energyEnvelope(audio.samples, WAV_SAMPLE_RATE),
        voice,
        cues: fresh,
      });
    }
  } catch (error) {
    if (signal.aborted || state !== target) return;
    job.status = "error";
    job.tries++;
    job.retryAt = Date.now() + RETRY_BASE_MS * job.tries;
    target.lastError = error instanceof Error ? error.message : String(error);
    console.warn(LOG_PREFIX, `chunk ${label} failed:`, target.lastError);
  } finally {
    job.controller = null;
    job.flexible = false;
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
  if (quota.whisper === "out") {
    diag.reason = "今天的語音辨識額度用完了";
    target.store.prune(t, (time) => isFinished(target.jobs.values(), time));
    return;
  }
  const low = quota.whisper === "low";
  const maxJobs = low ? 1 : MAX_PARALLEL_JOBS;
  const options = low ? LOW_QUOTA_SCHEDULE : DEFAULT_SCHEDULE;
  for (let guard = 0; inFlight(target) < maxJobs && guard < 4; guard++) {
    const next = nextNeeded([...target.jobs.values()], t, duration, Date.now(), options);
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
          flexible: next.flexible,
          controller: null,
          untranslated: false,
        };
    const readiness = target.store.readiness(job.start, Math.min(job.end, duration));
    if (readiness === "never") {
      // The buffer jumped past this part (e.g. a seek): don't block on it, but look again
      // later, since seeking back makes YouTube buffer it after all. Not a failed try.
      target.jobs.set(job.id, {
        ...job,
        status: "error",
        flexible: false,
        retryAt: Date.now() + SKIP_RECHECK_MS,
      });
      diag.reason = `跳過 ${job.start.toFixed(1)}–${job.end.toFixed(1)} 秒（沒有音訊）`;
      continue;
    }
    if (readiness === "wait") {
      // Playback is catching up: send what is already buffered instead of waiting.
      const head = target.store
        .coverage(job.start, job.end)
        .runs.find((run) => run.start <= job.start + 0.3);
      const have = head ? Math.min(head.end, job.end) - job.start : 0;
      // Short requests cost as much as 10 s ones: only when the playhead is close.
      const margin = job.start - t;
      if ((margin < 6 && have >= 8) || (margin < 2 && have >= 3)) {
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
  // Before lastError: with Whisper out nothing new comes, whatever the last chunk said
  // (often "translation paused", since the translation budget runs low first).
  else if (quota.whisper === "out") message = "AI 字幕：今天的語音辨識額度用完了";
  else if (target?.lastError) message = `AI 字幕：${target.lastError}`;
  else if (!diag.pageReady && playedLong) message = "AI 字幕：沒掛上播放器，請重新整理頁面";
  else if (!target && playedLong) {
    message = diag.audioBuffers
      ? "AI 字幕：有找到音訊但沒收到資料"
      : "AI 字幕：找不到音訊，請重新整理頁面";
  } else if (target && !onScreen) {
    // A finished chunk under the playhead with no caption: skipped for having no voice, or
    // Whisper's lines there were all dropped (made up). Not waiting for anything; said only
    // after a while (like "waiting"), so it does not flash at a start or after a stall.
    if (isFinished(target.jobs.values(), t)) {
      if (playedLong) message = "AI 字幕：這段沒有辨識到台詞";
    } else if (inFlight(target)) message = "AI 字幕：聽寫中…";
    else if (playedLong) message = "AI 字幕：等待音訊…";
  }
  overlay.setStatus(message);
}

function tick() {
  const target = currentState();
  const v = video();
  updateStatus(target, v);
  if (target && settingsLoaded)
    captionTrack.sync(target.videoId, target.cuesVersion, target.cues, settings);
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
  if (!settings.groqApiKey && !(settings.debugCapture && settings.debugDryRun)) {
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
  if (!(settings.debugCapture && settings.debugDryRun)) {
    refreshQuota();
    if (!quotaKnown) {
      diag.reason = "讀取 Groq 額度中";
      return;
    }
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
      quota,
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
