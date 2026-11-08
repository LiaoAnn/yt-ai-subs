// Offline evaluation of caption timing and line shape, from debug captures (see
// src/content/debug-capture.ts): re-runs segmentation on the saved Whisper response and
// compares each line with the loudness envelope of the audio that was sent.
// Only relative imports with values here: scripts/qa-replay.ts runs this file in plain Node.

import type { Cue } from "../shared/captions.ts";
import { whisperToCues, type WhisperVerboseJson } from "../background/segmentation.ts";
import { WHISPER_PROMPT_CHARS } from "../shared/video-context.ts";

export interface CaptureLike {
  videoId: string;
  start: number;
  end: number;
  sentSeconds: number;
  /** Missing in captures made before it was recorded. */
  context?: string;
  raw: unknown;
  envelope: number[];
  frameSeconds: number;
}

export interface CueTiming {
  cue: Cue;
  /** Line start minus the speech onset found near it (s); positive = the line is late. */
  startError: number | null;
  /** Line end minus the end of the speech it covers (s); positive = it lingers. */
  endError: number | null;
  /** Mean loudness above the chunk's noise floor while the line shows (dB). */
  loudnessAboveFloor: number;
  chars: number;
  duration: number;
}

const SMOOTH_FRAMES = 5; // 0.1 s at 20 ms frames

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index]!;
}

function smooth(envelope: readonly number[]): number[] {
  return envelope.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i - SMOOTH_FRAMES; j <= i + SMOOTH_FRAMES; j++) {
      if (j < 0 || j >= envelope.length) continue;
      sum += 10 ** (envelope[j]! / 10);
      count++;
    }
    return 10 * Math.log10(sum / count || 1e-10);
  });
}

export interface Levels {
  floor: number;
  speech: number;
  threshold: number;
}

/** Noise floor and a speech threshold for one chunk's envelope. */
export function levels(envelope: readonly number[]): Levels {
  const floor = percentile(envelope, 10);
  const speech = percentile(envelope, 90);
  return { floor, speech, threshold: floor + (speech - floor) * 0.4 };
}

/**
 * Times (s) where the smoothed envelope crosses the threshold upwards (onsets) and
 * downwards (offsets), ignoring dips shorter than `minGap` seconds.
 */
export function speechRuns(
  envelope: readonly number[],
  frameSeconds: number,
  threshold: number,
  minGap = 0.15,
): { start: number; end: number }[] {
  const smoothed = smooth(envelope);
  const runs: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (let i = 0; i <= smoothed.length; i++) {
    const loud = i < smoothed.length && smoothed[i]! >= threshold;
    if (loud && open === null) open = i;
    if (!loud && open !== null) {
      const start = open * frameSeconds;
      const end = i * frameSeconds;
      const last = runs.at(-1);
      if (last && start - last.end < minGap) last.end = end;
      else runs.push({ start, end });
      open = null;
    }
  }
  return runs;
}

/** Cues for one capture with times relative to the chunk start, as segmentation makes them. */
export function replayCues(capture: CaptureLike): Cue[] {
  return whisperToCues(
    (capture.raw ?? {}) as WhisperVerboseJson,
    (capture.context ?? "").slice(-WHISPER_PROMPT_CHARS),
  );
}

/** Timing of each cue against the envelope. Cue times are relative to the chunk start. */
export function evaluateCues(capture: CaptureLike, cues: readonly Cue[]): CueTiming[] {
  const { envelope, frameSeconds } = capture;
  const lv = levels(envelope);
  const runs = speechRuns(envelope, frameSeconds, lv.threshold);
  const sorted = cues.toSorted((a, b) => a.start - b.start);
  return sorted.map((cue, i) => {
    const previousEnd = i > 0 ? sorted[i - 1]!.end : -Infinity;
    const nextStart = sorted[i + 1]?.start ?? Infinity;
    // Only lines after a pause have an onset of their own to compare with (and not the
    // first line of a chunk, whose audio starts mid-sound).
    let startError: number | null = null;
    if (cue.start - previousEnd >= 0.4 && cue.start >= 0.5) {
      for (const run of runs) {
        if (run.start < Math.max(cue.start - 1, previousEnd) || run.start > cue.start + 1) continue;
        const error = cue.start - run.start;
        if (startError === null || Math.abs(error) < Math.abs(startError)) startError = error;
      }
    }
    // Likewise the end: only when a pause follows, against the end of the last speech run
    // that started during the line.
    let endError: number | null = null;
    const last = runs.filter((run) => run.start < cue.end - 0.1 && run.end > cue.start).at(-1);
    if (
      last &&
      nextStart - cue.end >= 0.4 &&
      last.end < nextStart - 0.1 &&
      last.end < capture.sentSeconds - 0.3
    ) {
      endError = cue.end - last.end;
    }
    const from = Math.max(0, Math.floor(cue.start / frameSeconds));
    const to = Math.min(envelope.length, Math.ceil(cue.end / frameSeconds));
    let power = 0;
    for (let f = from; f < to; f++) power += 10 ** (envelope[f]! / 10);
    const meanDb = to > from ? 10 * Math.log10(power / (to - from) || 1e-10) : lv.floor;
    return {
      cue,
      startError,
      endError,
      loudnessAboveFloor: meanDb - lv.floor,
      chars: [...cue.original].length,
      duration: cue.end - cue.start,
    };
  });
}

export interface Summary {
  chunks: number;
  cues: number;
  /** Requests shorter than 10 s (billed as 10 s). */
  shortChunks: number;
  meanChunkSeconds: number;
  startError: Distribution;
  endError: Distribution;
  chars: Distribution;
  duration: Distribution;
  /** Chunks whose last line does not end a sentence and runs into the chunk end. */
  cutSentences: number;
  /** Consecutive lines split inside a word: kanji|kanji, katakana|katakana, digit|unit. */
  badBreaks: number;
  /** Lines of fewer than 4 characters. */
  tinyLines: number;
}

const KANJI = /[\u3400-\u9fff]/;
const KATAKANA = /[\u30a0-\u30ff]/;

/** Whether the break between two consecutive lines falls inside a word. */
export function isBadBreak(before: string, after: string): boolean {
  const a = before.trim().slice(-1);
  const b = after.trim()[0] ?? "";
  if (/^\s/.test(after) || /\s$/.test(before)) return false;
  return (
    (KANJI.test(a) && KANJI.test(b)) ||
    (KATAKANA.test(a) && KATAKANA.test(b)) ||
    (/\d/.test(a) && /[\d\u3040-\u30ff\u3400-\u9fff]/.test(b))
  );
}

export interface Distribution {
  n: number;
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

const round = (x: number) => Math.round(x * 100) / 100;

export function distribution(values: readonly number[]): Distribution {
  const finite = values.filter(Number.isFinite);
  const mean = finite.reduce((a, b) => a + b, 0) / (finite.length || 1);
  return {
    n: finite.length,
    p10: round(percentile(finite, 10)),
    p50: round(percentile(finite, 50)),
    p90: round(percentile(finite, 90)),
    mean: round(mean),
  };
}

const SENTENCE_END = /[。！？!?…．.]$|[다요죠까네]\.?$/;

export function summarize(
  captures: readonly CaptureLike[],
  cuesOf: (capture: CaptureLike) => Cue[] = replayCues,
): Summary {
  const timings: CueTiming[] = [];
  let cutSentences = 0;
  let badBreaks = 0;
  for (const capture of captures) {
    const cues = cuesOf(capture);
    timings.push(...evaluateCues(capture, cues));
    const sortedCues = cues.toSorted((a, b) => a.start - b.start);
    for (let i = 1; i < sortedCues.length; i++) {
      if (isBadBreak(sortedCues[i - 1]!.original, sortedCues[i]!.original)) badBreaks++;
    }
    const last = cues.toSorted((a, b) => a.start - b.start).at(-1);
    if (last && last.end > capture.sentSeconds - 1 && !SENTENCE_END.test(last.original.trim())) {
      cutSentences++;
    }
  }
  return {
    chunks: captures.length,
    cues: timings.length,
    shortChunks: captures.filter((c) => c.sentSeconds < 10).length,
    meanChunkSeconds:
      Math.round(
        (captures.reduce((sum, c) => sum + c.sentSeconds, 0) / (captures.length || 1)) * 10,
      ) / 10,
    startError: distribution(timings.flatMap((t) => (t.startError === null ? [] : [t.startError]))),
    endError: distribution(timings.flatMap((t) => (t.endError === null ? [] : [t.endError]))),
    chars: distribution(timings.map((t) => t.chars)),
    duration: distribution(timings.map((t) => t.duration)),
    cutSentences,
    badBreaks,
    tinyLines: timings.filter((t) => t.chars < 4).length,
  };
}
