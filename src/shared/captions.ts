// Caption data shared by the content script (display, cache) and the background
// (speech-to-text output). Times are seconds on the video's timeline.
//
// The shape maps one-to-one onto YouTube's timedtext "json3" events (see toJson3), so a
// later stage can hand the same cues to YouTube's own caption (CC) menu.

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
 * Converts cues to json3. `field` picks which text goes in the track; "translation" falls
 * back to the original for cues that have no translation yet.
 */
export function toJson3(cues: readonly Cue[], field: "original" | "translation"): Json3 {
  const events: Json3Event[] = [];
  for (const cue of cues.toSorted((a, b) => a.start - b.start)) {
    const text = field === "translation" ? (cue.translation ?? cue.original) : cue.original;
    const tStartMs = Math.round(cue.start * 1000);
    const dDurationMs = Math.round(cue.end * 1000) - tStartMs;
    if (!text.trim() || dDurationMs <= 0) continue;
    events.push({ tStartMs, dDurationMs, segs: [{ utf8: text }] });
  }
  return { wireMagic: "pb3", events };
}
