// CI fixtures of the evaluation set: a stretch of one video's voice features (per 20 ms,
// as the content script computes them) with where people talk, and no caption text.
// Written by `node scripts/qa-eval.ts --write-fixture`; src/qa/fixture.test.ts asserts that
// voice detection does not lose speech or let more music through on them.

import type { DatasetVideo } from "./dataset.ts";
import type { Interval } from "./ground-truth.ts";
import {
  FRAME,
  scoreChunks,
  simulateChunks,
  type FeatureTimeline,
  type SpeechTruth,
  type VoiceScore,
} from "./voice-eval.ts";

type Pair = [number, number];

export interface EvalFixture {
  name: string;
  videoId: string;
  language: string;
  category: string;
  voice: string;
  /** The stretch on the video's timeline (seconds); every time below is relative to it. */
  from: number;
  to: number;
  frames: {
    band: number[];
    bandShare: number[];
    flatness: number[];
    wideShare: number[];
    loudness: number[];
  };
  speech: Pair[];
  lines: Pair[];
  /** Anything that might be speech (creator and automatic captions), or null. */
  anySpeech: Pair[] | null;
  precision: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function clip(intervals: readonly Interval[], from: number, to: number): Pair[] {
  return intervals
    .filter((x) => x.end > from && x.start < to)
    .map((x) => [r2(Math.max(x.start, from) - from), r2(Math.min(x.end, to) - from)] as Pair);
}

/** A fixture from a feature timeline and its speech truth. */
export function fixtureFrom(
  t: FeatureTimeline,
  truth: SpeechTruth,
  video: DatasetVideo,
  from: number,
  to: number,
  name: string,
): EvalFixture {
  const a = Math.round(from / FRAME);
  const b = Math.round(to / FRAME);
  const cut = (x: number[]) => x.slice(a, b).map((v) => (Number.isNaN(v) ? null : v)) as number[];
  return {
    name,
    videoId: video.videoId,
    language: video.language,
    category: video.category,
    voice: video.voice,
    from,
    to,
    frames: {
      band: cut(t.band),
      bandShare: cut(t.bandShare),
      flatness: cut(t.flatness),
      wideShare: cut(t.wideShare),
      loudness: cut(t.loudness),
    },
    speech: clip(truth.speech, from, to),
    lines: clip(truth.lines, from, to),
    anySpeech: truth.anySpeech ? clip(truth.anySpeech, from, to) : null,
    precision: truth.precision,
  };
}

const toIntervals = (pairs: readonly Pair[]) => pairs.map(([start, end]) => ({ start, end }));

const nan = (x: (number | null)[]) => x.map((v) => (v === null ? NaN : v));

/** Simulated 10 s and 30 s chunks on a fixture, scored as in scripts/qa-eval.ts. */
export function scoreFixture(f: EvalFixture): VoiceScore[] {
  const t: FeatureTimeline = {
    band: nan(f.frames.band),
    bandShare: nan(f.frames.bandShare),
    flatness: nan(f.frames.flatness),
    wideShare: nan(f.frames.wideShare),
    loudness: nan(f.frames.loudness),
  };
  const truth: SpeechTruth = {
    speech: toIntervals(f.speech),
    lines: toIntervals(f.lines),
    anySpeech: f.anySpeech ? toIntervals(f.anySpeech) : null,
    precision: f.precision,
  };
  return [10, 30].map((seconds) => scoreChunks(t, simulateChunks(t, seconds), truth, seconds));
}
