// Development only (the debugCapture setting): keeps what each chunk produced, so timing
// and segmentation can be evaluated offline without calling the API again. Stored in
// chrome.storage.local under `debug:<video>:<start>`; read it from the popup page.
// Holds transcripts of other people's videos: never commit what it collects.

import type { Cue } from "@/shared/captions";
import { LOG_PREFIX } from "@/shared/log";
import type { Settings } from "@/shared/settings";
import { FRAME_SECONDS } from "./energy";
import type { VoiceFeatures } from "./voice";

export const DEBUG_PREFIX = "debug:";

export interface DebugCapture {
  videoId: string;
  /** Chunk on the video's timeline (seconds); `end` after any trim. */
  start: number;
  end: number;
  /** Seconds of audio sent (before any trim). */
  sentSeconds: number;
  whisperModel: string;
  sourceLanguage: string;
  /** Whisper's prompt: the recent captions only (buildWhisperPrompt). */
  context: string;
  /** Glossary entries sent with the translation request, if any. */
  glossary?: [string, string][];
  /** Terms the translator reported for this chunk. */
  terms?: Record<string, unknown>;
  /** Whisper's verbose_json response, times relative to `start`. */
  raw: unknown;
  /** Loudness of the audio sent, dBFS per `frameSeconds`, from `start`. */
  envelope: number[];
  frameSeconds: number;
  /** Spectral features per 20 ms frame (voiceFeatures), from `start`. */
  voice?: VoiceFeatures;
  /** The cues shown for this chunk, on the video's timeline. */
  cues: Cue[];
  savedAt: number;
}

export function saveDebugCapture(
  settings: Settings,
  capture: Omit<DebugCapture, "whisperModel" | "sourceLanguage" | "frameSeconds" | "savedAt">,
): void {
  const entry: DebugCapture = {
    ...capture,
    whisperModel: settings.whisperModel,
    sourceLanguage: settings.sourceLanguage,
    frameSeconds: FRAME_SECONDS,
    savedAt: Date.now(),
  };
  const key = `${DEBUG_PREFIX}${capture.videoId}:${capture.start.toFixed(2)}`;
  chrome.storage.local
    .set({ [key]: entry })
    .catch((error: unknown) => console.warn(LOG_PREFIX, "could not save a debug capture", error));
}
