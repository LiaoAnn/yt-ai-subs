// Caption data shared by the content script (display, cache) and the background
// (speech-to-text output). Times are seconds on the video's timeline.
//
// The shape maps one-to-one onto YouTube's timedtext "json3" events (see toJson3): the page
// script serves them as a caption track in YouTube's own caption (CC) menu.

export interface Cue {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds (exclusive). */
  end: number;
  /** Text in the source language, as transcribed. */
  original: string;
  /** Translated text; absent in transcribe-only mode or until the translation arrives. */
  translation?: string;
}

/** YouTube timedtext json3: the format the player's caption tracks load. */
export interface Json3 {
  wireMagic: "pb3";
  events: Json3Event[];
}

export interface Json3Event {
  tStartMs: number;
  dDurationMs: number;
  segs: { utf8: string }[];
}

/**
 * Which text goes in a track: the original, the translation, or both (the original on the
 * line above the translation). "translation" and "both" fall back to the original for cues
 * that have no translation yet.
 */
export type TrackText = "original" | "translation" | "both";

function cueText(cue: Cue, field: TrackText): string {
  if (field === "original" || !cue.translation) return cue.original;
  if (field === "both" && cue.translation !== cue.original) {
    return `${cue.original}\n${cue.translation}`;
  }
  return cue.translation;
}

/** Converts cues to json3. */
export function toJson3(cues: readonly Cue[], field: TrackText): Json3 {
  const events: Json3Event[] = [];
  for (const cue of cues.toSorted((a, b) => a.start - b.start)) {
    const text = cueText(cue, field);
    const tStartMs = Math.round(cue.start * 1000);
    const dDurationMs = Math.round(cue.end * 1000) - tStartMs;
    if (!text.trim() || dDurationMs <= 0) continue;
    events.push({ tStartMs, dDurationMs, segs: [{ utf8: text }] });
  }
  return { wireMagic: "pb3", events };
}
