// Messages between the extension's contexts.
//
// page script (MAIN world) --window.postMessage--> content script (isolated world)
// content script --chrome.runtime.sendMessage--> background service worker

import type { Cue } from "./captions";

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

export type PageMessage = PageReadyMessage | AudioBufferMessage | SegmentMessage;

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
    default:
      return false;
  }
}

export interface PingMessage {
  type: "ping";
}

export interface TranscribeMessage {
  type: "transcribe";
  /** Lets the content script cancel the request with a CancelMessage. */
  requestId: string;
  /** 16 kHz mono WAV, base64 (runtime messages are JSON, so no ArrayBuffers). */
  wavBase64: string;
  durationSeconds: number;
  /** Recent original-language text, given to Whisper as a prompt. */
  context: string;
}

export interface TranslateMessage {
  type: "translate";
  requestId: string;
  lines: string[];
  /** Previous lines, for context only. */
  context: string;
}

export interface CancelMessage {
  type: "cancel";
  requestIds: string[];
}

export type RuntimeMessage = PingMessage | TranscribeMessage | TranslateMessage | CancelMessage;

export interface PongReply {
  type: "pong";
  version: string;
}

export interface FailedReply {
  ok: false;
  error: string;
  /** The request was cancelled; not an error to show. */
  aborted: boolean;
}

export interface CallTimings {
  latencyMs: number;
  waitedMs: number;
}

export type TranscribeReply =
  | ({ ok: true; cues: Cue[]; language: string } & CallTimings)
  | FailedReply;

export type TranslateReply =
  | ({ ok: true; lines: string[]; totalTokens: number } & CallTimings)
  | FailedReply;
