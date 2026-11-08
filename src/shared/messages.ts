// Messages between the extension's contexts.
//
// page script (MAIN world) --window.postMessage--> content script (isolated world)
// content script --window.postMessage (PAGE_COMMAND_TAG)--> page script
// content script --chrome.runtime.sendMessage--> background service worker
// popup --chrome.tabs.sendMessage--> content script

import type { Cue, Json3Event } from "./captions";
import type { QuotaLevels } from "./quota";

/** Tag on every window message, so the content script ignores YouTube's own messages. */
export const PAGE_MESSAGE_TAG = "__ytAiSubs";

interface Tagged {
  [PAGE_MESSAGE_TAG]: true;
}

/** The page script is running and has hooked MediaSource. */
export interface PageReadyMessage extends Tagged {
  type: "page-ready";
}

/** YouTube created an audio SourceBuffer. */
export interface AudioBufferMessage extends Tagged {
  type: "audio-buffer";
  mime: string;
}

/** A copy of bytes YouTube appended to an audio SourceBuffer (never during ads). */
export interface SegmentMessage extends Tagged {
  type: "segment";
  /** Which SourceBuffer, numbered by the page script. */
  bufferId: number;
  mime: string;
  videoId: string | null;
  /** The bytes start with an init segment (WebM EBML header or MP4 ftyp). */
  init: boolean;
  /** Time span the append added to the buffered ranges, if any (seconds). */
  start: number | null;
  end: number | null;
  bytes: ArrayBuffer;
}

/** How captions are shown for a video: YouTube's own CC menu, or the fallback overlay. */
export type DisplayMode = "pending" | "cc" | "overlay";

/** The page script's verdict on the CC-menu track for the player's current video. */
export interface CaptionModeMessage extends Tagged {
  type: "caption-mode";
  videoId: string | null;
  mode: DisplayMode;
  /** Why the overlay is used; empty otherwise. */
  reason: string;
  /** The player response says the video is a live stream (no captions for it). */
  live?: boolean;
}

export type PageMessage =
  | PageReadyMessage
  | AudioBufferMessage
  | SegmentMessage
  | CaptionModeMessage;

const DISPLAY_MODES: readonly unknown[] = ["pending", "cc", "overlay"] satisfies DisplayMode[];

const isNumberOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));

/**
 * Checks the shape of a window message. Any script on the page can post one that passes,
 * so treat the payload as untrusted input even when this returns true.
 */
export function isPageMessage(data: unknown): data is PageMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message[PAGE_MESSAGE_TAG] !== true) return false;
  switch (message.type) {
    case "page-ready":
      return true;
    case "audio-buffer":
      return typeof message.mime === "string";
    case "segment":
      return (
        Number.isInteger(message.bufferId) &&
        typeof message.mime === "string" &&
        (message.videoId === null || typeof message.videoId === "string") &&
        typeof message.init === "boolean" &&
        isNumberOrNull(message.start) &&
        isNumberOrNull(message.end) &&
        message.bytes instanceof ArrayBuffer
      );
    case "caption-mode":
      return (
        (message.videoId === null || typeof message.videoId === "string") &&
        DISPLAY_MODES.includes(message.mode) &&
        typeof message.reason === "string" &&
        (message.live === undefined || typeof message.live === "boolean")
      );
    default:
      return false;
  }
}

/** Tag on window messages from the content script to the page script. */
export const PAGE_COMMAND_TAG = "__ytAiSubsToPage";

/** The caption track's events for a video (replaces what was sent before). */
export interface TrackCuesCommand {
  [PAGE_COMMAND_TAG]: true;
  type: "track-cues";
  videoId: string;
  events: Json3Event[];
}

export type PageCommand = TrackCuesCommand;

const isJson3Event = (value: unknown): value is Json3Event => {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    Number.isFinite(event.tStartMs) &&
    Number.isFinite(event.dDurationMs) &&
    Array.isArray(event.segs) &&
    event.segs.every(
      (seg: unknown) =>
        typeof seg === "object" &&
        seg !== null &&
        typeof (seg as Record<string, unknown>).utf8 === "string",
    )
  );
};

/** Checks the shape of a content → page command (any page script can forge one). */
export function isPageCommand(data: unknown): data is PageCommand {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message[PAGE_COMMAND_TAG] === true &&
    message.type === "track-cues" &&
    typeof message.videoId === "string" &&
    Array.isArray(message.events) &&
    message.events.every(isJson3Event)
  );
}

export interface PingMessage {
  type: "ping";
}

export interface TranscribeMessage {
  type: "transcribe";
  /** Lets the content script cancel the request with a CancelMessage. */
  requestId: string;
  /** The video the audio is from, for the per-video usage in the popup. */
  videoId: string;
  /** 16 kHz mono WAV, base64 (runtime messages are JSON, so no ArrayBuffers). */
  wavBase64: string;
  durationSeconds: number;
  /** Recent original-language text, given to Whisper as a prompt. */
  context: string;
}

export interface TranslateMessage {
  type: "translate";
  requestId: string;
  videoId: string;
  lines: string[];
  /** Previous lines ("original → translation" when translated), for context only. */
  context: string;
}

export interface CancelMessage {
  type: "cancel";
  requestIds: string[];
}

/** Asks the background how much of the day's Groq budget is left. */
export interface GetQuotaMessage {
  type: "get-quota";
}

export type RuntimeMessage =
  | PingMessage
  | TranscribeMessage
  | TranslateMessage
  | CancelMessage
  | GetQuotaMessage;

export interface QuotaReply {
  type: "quota";
  levels: QuotaLevels;
}

/** From the popup to a tab's content script. */
export interface GetDisplayModeMessage {
  type: "get-display-mode";
}

export interface DisplayModeReply {
  videoId: string | null;
  /** "off": this kind of video gets no captions (live, Shorts); `reason` says which. */
  mode: DisplayMode | "off";
  reason: string;
}

export interface PongReply {
  type: "pong";
  version: string;
}

export interface FailedReply {
  ok: false;
  error: string;
  /** The request was cancelled; not an error to show. */
  aborted: boolean;
  /** Not sent: translation is paused to keep the rest of the day's budget. */
  quotaPaused?: boolean;
}

export interface CallTimings {
  latencyMs: number;
  waitedMs: number;
  /** The day's budget levels after this request. */
  quota: QuotaLevels;
}

export type TranscribeReply =
  | ({
      ok: true;
      cues: Cue[];
      language: string;
      /** The raw verbose_json response, only with the debugCapture setting. */
      raw?: unknown;
    } & CallTimings)
  | FailedReply;

export type TranslateReply =
  | ({ ok: true; lines: string[]; totalTokens: number } & CallTimings)
  | FailedReply;
