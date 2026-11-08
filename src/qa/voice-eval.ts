// Layer A of the evaluation: voice detection (send or skip a chunk). Debug captures hold
// the spectral features of every chunk the extension decoded; laid end to end they give a
// feature timeline of the video, on which a chunk starting at every second (10 s and 30 s
// long) is decided as the content script would, and scored against where people talk.

import {
  MIN_VOICED_SHARE,
  VOICE_FRAME_SECONDS,
  bestVoicedWindow,
  type VoiceFeatures,
} from "../content/voice.ts";
import { overlapLength, type Interval } from "./ground-truth.ts";

/** What a capture contributes (src/content/debug-capture.ts). */
export interface FeatureCapture {
  start: number;
  voice?: VoiceFeatures;
  envelope: number[];
  frameSeconds: number;
}

/** Features per 20 ms frame from t = 0; NaN where no capture covered the frame. */
export interface FeatureTimeline {
  band: number[];
  bandShare: number[];
  flatness: number[];
  wideShare: number[];
  /** Loudness, dBFS per frame (the envelope's frames are also 20 ms). */
  loudness: number[];
}

export const FRAME = VOICE_FRAME_SECONDS;

/** Lays the captures' features end to end (later captures overwrite overlaps). */
export function featureTimeline(captures: readonly FeatureCapture[]): FeatureTimeline {
  const withVoice = captures.filter((c) => c.voice).toSorted((a, b) => a.start - b.start);
  const frames = Math.max(
    0,
    ...withVoice.map((c) => Math.round(c.start / FRAME) + c.voice!.band.length),
  );
  const empty = () => Array.from({ length: frames }, () => NaN);
  const out: FeatureTimeline = {
    band: empty(),
    bandShare: empty(),
    flatness: empty(),
    wideShare: empty(),
    loudness: empty(),
  };
  for (const c of withVoice) {
    const offset = Math.round(c.start / FRAME);
    const v = c.voice!;
    for (let i = 0; i < v.band.length; i++) {
      out.band[offset + i] = v.band[i]!;
      out.bandShare[offset + i] = v.bandShare[i]!;
      out.flatness[offset + i] = v.flatness[i]!;
      out.wideShare[offset + i] = v.wideShare?.[i] ?? NaN;
    }
    if (Math.abs(c.frameSeconds - FRAME) < 1e-9) {
      for (let i = 0; i < c.envelope.length; i++) out.loudness[offset + i] = c.envelope[i]!;
    }
  }
  return out;
}

/** Features of [start, start + seconds), or null when part of it was never captured. */
export function sliceFeatures(
  t: FeatureTimeline,
  start: number,
  seconds: number,
): VoiceFeatures | null {
  const from = Math.round(start / FRAME);
  const to = from + Math.round(seconds / FRAME);
  if (to > t.band.length) return null;
  let missing = 0;
  for (let i = from; i < to; i++) if (Number.isNaN(t.band[i])) missing++;
  if (missing > (to - from) * 0.02) return null;
  // A missing frame counts as silence: not voiced.
  const pick = (a: number[], fill: number) =>
    a.slice(from, to).map((x) => (Number.isNaN(x) ? fill : x));
  const hasWide = t.wideShare.slice(from, to).some((x) => !Number.isNaN(x));
  return {
    band: pick(t.band, -100),
    bandShare: pick(t.bandShare, 0),
    flatness: pick(t.flatness, 100),
    ...(hasWide ? { wideShare: pick(t.wideShare, 0) } : {}),
  };
}

export interface SimulatedChunk extends Interval {
  score: number;
  sent: boolean;
}

/** A decision as the content script makes it: `bestVoicedWindow >= MIN_VOICED_SHARE`. */
export type Decide = (features: VoiceFeatures) => number;

/** Chunks of `seconds` starting every `step` seconds in [from, to). */
export function simulateChunks(
  t: FeatureTimeline,
  seconds: number,
  from = 0,
  to = t.band.length * FRAME,
  step = 1,
  decide: Decide = bestVoicedWindow,
  threshold = MIN_VOICED_SHARE,
): SimulatedChunk[] {
  const out: SimulatedChunk[] = [];
  for (let start = from; start + seconds <= to + 1e-9; start += step) {
    const features = sliceFeatures(t, start, seconds);
    if (!features) continue;
    const score = decide(features);
    out.push({ start, end: start + seconds, score, sent: score >= threshold });
  }
  return out;
}

/** Median loudness (dBFS) of a stretch of the timeline. */
export function medianLoudness(t: FeatureTimeline, span: Interval): number {
  const values = t.loudness
    .slice(Math.round(span.start / FRAME), Math.round(span.end / FRAME))
    .filter((x) => !Number.isNaN(x))
    .toSorted((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)]! : -100;
}

/** No-speech chunks louder than this (median dBFS) count as music or sound, else quiet. */
export const LOUD_DB = -45;

export interface VoiceScore {
  chunkSeconds: number;
  chunks: number;
  /** Talk seconds in sent chunks / talk seconds in all chunks. */
  talkRecall: number | null;
  talkSeconds: number;
  talkSentSeconds: number;
  /** Lines (by midpoint) with at least one simulated chunk that was skipped. */
  linesEverSkipped: number;
  lines: number;
  /** Mean share of a line's chunks that were sent. */
  lineRecall: number | null;
  /** Chunks with no speech at all (ground truth and the automatic track agree). */
  noSpeechChunks: number;
  /** Of those, loud (music, sound effects) and how many were skipped. */
  loudNoSpeech: number;
  loudSkipped: number;
  quietNoSpeech: number;
  quietSkipped: number;
  /** Sent chunks that hold speech / sent chunks (only where the source allows it). */
  precision: number | null;
  sent: number;
}

export interface SpeechTruth {
  /** Where people talk (creator lines). */
  speech: Interval[];
  /** Lines to count (by midpoint), usually the same as speech before merging. */
  lines: Interval[];
  /**
   * Anything that might be speech (creator lines and the automatic track's phrases), or
   * null when the source cannot say where nobody talks.
   */
  anySpeech: Interval[] | null;
  /** The source's lines leave gaps where nobody talks: precision can be measured. */
  precision: boolean;
}

/** Scores simulated chunks against where people talk. */
export function scoreChunks(
  t: FeatureTimeline,
  chunks: readonly SimulatedChunk[],
  truth: SpeechTruth,
  chunkSeconds: number,
): VoiceScore {
  let talkAll = 0;
  let talkSent = 0;
  for (const chunk of chunks) {
    const talk = overlapLength(chunk, truth.speech);
    talkAll += talk;
    if (chunk.sent) talkSent += talk;
  }
  let everSkipped = 0;
  const recalls: number[] = [];
  let counted = 0;
  for (const line of truth.lines) {
    const mid = (line.start + line.end) / 2;
    const covering = chunks.filter((c) => c.start <= mid && mid < c.end);
    if (!covering.length) continue;
    counted++;
    if (covering.some((c) => !c.sent)) everSkipped++;
    recalls.push(covering.filter((c) => c.sent).length / covering.length);
  }
  let loud = 0;
  let loudSkipped = 0;
  let quiet = 0;
  let quietSkipped = 0;
  let sentWithSpeech = 0;
  let sent = 0;
  if (truth.anySpeech) {
    const padded = truth.anySpeech.map((s) => ({ start: s.start - 0.5, end: s.end + 0.5 }));
    for (const chunk of chunks) {
      const any = overlapLength(chunk, padded) > 0;
      if (chunk.sent) {
        sent++;
        if (overlapLength(chunk, truth.speech) >= 0.5) sentWithSpeech++;
      }
      if (any) continue;
      if (medianLoudness(t, chunk) > LOUD_DB) {
        loud++;
        if (!chunk.sent) loudSkipped++;
      } else {
        quiet++;
        if (!chunk.sent) quietSkipped++;
      }
    }
  }
  return {
    chunkSeconds,
    chunks: chunks.length,
    talkRecall: talkAll ? talkSent / talkAll : null,
    talkSeconds: talkAll,
    talkSentSeconds: talkSent,
    linesEverSkipped: everSkipped,
    lines: counted,
    lineRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    noSpeechChunks: loud + quiet,
    loudNoSpeech: loud,
    loudSkipped,
    quietNoSpeech: quiet,
    quietSkipped,
    precision: truth.precision && sent ? sentWithSpeech / sent : null,
    sent,
  };
}
