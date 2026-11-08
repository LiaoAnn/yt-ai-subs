// Messages between the extension's contexts.
//
// page script (MAIN world) --window.postMessage--> content script (isolated world)
// content script --window.postMessage (PAGE_COMMAND_TAG)--> page script
// content script --chrome.runtime.sendMessage--> background service worker
// popup --chrome.tabs.sendMessage--> content script

import type { Cue, Json3Event } from "./captions";
import type { QuotaLevels } from "./quota";
import type { VideoInfo } from "./video-context";

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

/**
 * How captions are shown for a video: YouTube's own CC menu, the fallback overlay, or the
 * creator's own track in the target language (nothing of ours is shown or paid for).
 */
export type DisplayMode = "pending" | "cc" | "overlay" | "creator";

/** The page script's verdict on the CC-menu track for the player's current video. */
export interface CaptionModeMessage extends Tagged {
  type: "caption-mode";
  videoId: string | null;
  mode: DisplayMode;
  /** Why the overlay is used; empty otherwise. */
  reason: string;
  /** The player response says the video is a live stream (no captions for it). */
  live?: boolean;
  /** The player plays an AI-dubbed audio track (no captions while it does). */
  dubbed?: boolean;
}

/** Title, channel, description and tags of a video, from a player response. */
export interface VideoInfoMessage extends Tagged {
  type: "video-info";
  info: VideoInfo;
}

/**
 * What the page script knows about the creator's own caption tracks for a video
 * (src/page/creator-hooks.ts), in reply to a GetCreatorCaptionsCommand:
 * - "unknown": no player response for the video seen yet;
 * - "none": no creator track worth using (transcribe with Whisper);
 * - "target": a creator track in our track's language; the page script selects it and
 *   adds no track of ours: transcribe and translate nothing;
 * - "pending": a creator track in the spoken language is being fetched;
 * - "fetched": it and YouTube's automatic track of that language (null if there is none);
 *   the content script decides whether it replaces Whisper (analyzeCreatorTrack);
 * - "failed": it could not be fetched (transcribe with Whisper).
 */
export type CreatorStatus = "unknown" | "none" | "target" | "pending" | "fetched" | "failed";

export interface CreatorCaptionsMessage extends Tagged {
  type: "creator-captions";
  videoId: string;
  status: CreatorStatus;
  /** The creator track's language and name ("target", "pending", "fetched"). */
  languageCode?: string;
  name?: string;
  creator?: Json3Event[];
  asr?: Json3Event[] | null;
  /** Why it failed. */
  reason?: string;
}

export type PageMessage =
  | PageReadyMessage
  | AudioBufferMessage
  | SegmentMessage
  | CaptionModeMessage
  | VideoInfoMessage
  | CreatorCaptionsMessage;

const DISPLAY_MODES: readonly unknown[] = [
  "pending",
  "cc",
  "overlay",
  "creator",
] satisfies DisplayMode[];
const CREATOR_STATUSES: readonly unknown[] = [
  "unknown",
  "none",
  "target",
  "pending",
  "fetched",
  "failed",
] satisfies CreatorStatus[];
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

const isNumberOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));

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
        (message.live === undefined || typeof message.live === "boolean") &&
        (message.dubbed === undefined || typeof message.dubbed === "boolean")
      );
    case "video-info": {
      const info = message.info as Record<string, unknown> | null;
      return (
        typeof info === "object" &&
        info !== null &&
        typeof info.videoId === "string" &&
        typeof info.title === "string" &&
        typeof info.channel === "string" &&
        typeof info.description === "string" &&
        Array.isArray(info.keywords) &&
        info.keywords.every((k) => typeof k === "string")
      );
    }
    case "creator-captions":
      return (
        typeof message.videoId === "string" &&
        CREATOR_STATUSES.includes(message.status) &&
        isOptionalString(message.languageCode) &&
        isOptionalString(message.name) &&
        isOptionalString(message.reason) &&
        (message.creator === undefined ||
          (Array.isArray(message.creator) && message.creator.every(isJson3Event))) &&
        (message.asr === undefined ||
          message.asr === null ||
          (Array.isArray(message.asr) && message.asr.every(isJson3Event)))
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

/** Asks the page script what it knows about the video's creator tracks. */
export interface GetCreatorCaptionsCommand {
  [PAGE_COMMAND_TAG]: true;
  type: "get-creator-captions";
  videoId: string;
}

export type PageCommand = TrackCuesCommand | GetCreatorCaptionsCommand;

/** Checks the shape of a content → page command (any page script can forge one). */
export function isPageCommand(data: unknown): data is PageCommand {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message[PAGE_COMMAND_TAG] !== true || typeof message.videoId !== "string") return false;
  if (message.type === "get-creator-captions") return true;
  return (
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
  /** Whisper's prompt: the recent captions only (buildWhisperPrompt). */
  context: string;
}

export interface TranslateMessage {
  type: "translate";
  requestId: string;
  videoId: string;
  lines: string[];
  /** Previous lines ("original → translation" when translated), for context only. */
  context: string;
  /** The video's title and channel, for context. */
  video?: { title: string; channel: string };
  /** Renderings already used in this video for terms in these lines (source, translation). */
  glossary?: [string, string][];
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
  /** "off": no captions for this video (live, Shorts, an AI dub playing); `reason` says why. */
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
  | ({
      ok: true;
      lines: string[];
      totalTokens: number;
      /** Names and terms the translator says it translated: source -> translation. */
      terms: Record<string, unknown>;
    } & CallTimings)
  | FailedReply;
