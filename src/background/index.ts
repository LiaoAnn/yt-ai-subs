// Background service worker (ES module): the only place that talks to Groq. One rate
// limiter covers every tab, and its state survives service worker restarts in
// chrome.storage.session.
import { LOG_PREFIX } from "@/shared/log";
import type {
  FailedReply,
  PongReply,
  QuotaReply,
  RuntimeMessage,
  TranscribeReply,
  TranslateReply,
} from "@/shared/messages";
import {
  LIMITER_STORAGE_KEY,
  TRANSLATION_PAUSED_MESSAGE,
  USAGE_STORAGE_KEY,
  parseLedger,
  quotaLevels,
  recordUsage,
  translationPaused,
  type QuotaLevels,
  type UsageLedger,
} from "@/shared/quota";
import { loadSettings } from "@/shared/settings";
import { transcribe, translate } from "./groq";
import { RateLimiter, type Cost, type LimiterState, type RequestKind } from "./rate-limiter";

console.log(LOG_PREFIX, "background service worker loaded");

const limiterReady: Promise<RateLimiter> = chrome.storage.session.get(LIMITER_STORAGE_KEY).then(
  (stored) => new RateLimiter(undefined, stored[LIMITER_STORAGE_KEY] as LimiterState | undefined),
  () => new RateLimiter(),
);

function persistLimiter(limiter: RateLimiter) {
  chrome.storage.session.set({ [LIMITER_STORAGE_KEY]: limiter.snapshot() }).catch(() => {
    // Losing the log only makes the next limits less exact; Groq's headers still apply.
  });
}

// What was billed per hour and per video, for the popup and the daily budget estimates.
// In chrome.storage.local so a browser restart does not forget today's usage.
const ledgerReady: Promise<UsageLedger> = chrome.storage.local.get(USAGE_STORAGE_KEY).then(
  (stored) => parseLedger(stored[USAGE_STORAGE_KEY]),
  () => parseLedger(undefined),
);

function noteBilled(ledger: UsageLedger, kind: RequestKind, videoId: string | null, cost: Cost) {
  recordUsage(ledger, kind, videoId, cost, Date.now());
  chrome.storage.local.set({ [USAGE_STORAGE_KEY]: ledger }).catch(() => {
    // Only the popup's numbers and the daily estimates get less exact.
  });
}

async function currentLevels(): Promise<QuotaLevels> {
  const [limiter, ledger] = await Promise.all([limiterReady, ledgerReady]);
  return quotaLevels(limiter.snapshot(), ledger, Date.now());
}

/** In-flight requests by "<tabId>:<requestId>", so the content script can cancel them. */
const inFlight = new Map<string, AbortController>();

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function failure(error: unknown, signal: AbortSignal): FailedReply {
  if (signal.aborted) return { ok: false, error: "cancelled", aborted: true };
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    aborted: false,
  };
}

async function handle(
  message: RuntimeMessage,
  tabId: number,
): Promise<PongReply | QuotaReply | TranscribeReply | TranslateReply | undefined> {
  if (message.type === "ping") {
    return { type: "pong", version: chrome.runtime.getManifest().version };
  }
  if (message.type === "cancel") {
    for (const id of message.requestIds) inFlight.get(`${tabId}:${id}`)?.abort();
    return undefined;
  }
  if (message.type === "get-quota") {
    return { type: "quota", levels: await currentLevels() };
  }
  const key = `${tabId}:${message.requestId}`;
  const controller = new AbortController();
  inFlight.set(key, controller);
  const { signal } = controller;
  try {
    const [settings, limiter, ledger] = await Promise.all([
      loadSettings(),
      limiterReady,
      ledgerReady,
    ]);
    if (!settings.groqApiKey) throw new Error("請先在擴充功能設定填 Groq API key");
    const changed = () => persistLimiter(limiter);
    const videoId = typeof message.videoId === "string" ? message.videoId : null;
    if (message.type === "transcribe") {
      const result = await transcribe(
        limiter,
        settings,
        base64ToBytes(message.wavBase64),
        message.durationSeconds,
        message.context,
        signal,
        changed,
        (cost) => noteBilled(ledger, "whisper", videoId, cost),
      );
      return {
        ok: true,
        cues: result.cues,
        language: result.language,
        ...result.stats,
        quota: await currentLevels(),
        ...(settings.debugCapture ? { raw: result.raw } : {}),
      };
    }
    // Near the end of the day's translation budget, keep it (and Whisper's) for the
    // original captions: answer without calling Groq.
    if (translationPaused(await currentLevels())) {
      return { ok: false, error: TRANSLATION_PAUSED_MESSAGE, aborted: false, quotaPaused: true };
    }
    const result = await translate(
      limiter,
      settings,
      message.lines,
      message.context,
      signal,
      changed,
      (cost) => noteBilled(ledger, "chat", videoId, cost),
    );
    return {
      ok: true,
      lines: result.lines,
      totalTokens: result.totalTokens,
      ...result.stats,
      quota: await currentLevels(),
    };
  } catch (error) {
    return failure(error, signal);
  } finally {
    inFlight.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  // Only our own content scripts in tabs may use the API key.
  if (sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab?.id ?? -1;
  handle(message, tabId).then(sendResponse, (error: unknown) =>
    sendResponse({ ok: false, error: String(error), aborted: false } satisfies FailedReply),
  );
  return true;
});
