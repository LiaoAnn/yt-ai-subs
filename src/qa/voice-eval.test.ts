import { describe, expect, it } from "vitest";
import {
  featureTimeline,
  scoreChunks,
  simulateChunks,
  sliceFeatures,
  type FeatureCapture,
} from "./voice-eval";

const FPS = 50; // 20 ms frames

/** A capture of `seconds` of frames, voiced (speech band dominant, tonal) or not. */
function capture(
  start: number,
  seconds: number,
  voiced: (t: number) => boolean,
  db = -30,
): FeatureCapture {
  const n = Math.round(seconds * FPS);
  const t = (i: number) => start + i / FPS;
  return {
    start,
    frameSeconds: 0.02,
    envelope: Array.from({ length: n }, () => db),
    voice: {
      band: Array.from({ length: n }, (_, i) => (voiced(t(i)) ? -30 : -70)),
      bandShare: Array.from({ length: n }, (_, i) => (voiced(t(i)) ? 70 : 20)),
      flatness: Array.from({ length: n }, (_, i) => (voiced(t(i)) ? 10 : 50)),
      wideShare: Array.from({ length: n }, (_, i) => (voiced(t(i)) ? 80 : 30)),
    },
  };
}

describe("featureTimeline", () => {
  it("lays captures end to end on the video's timeline", () => {
    const t = featureTimeline([capture(0, 10, () => true), capture(10, 10, () => false)]);
    expect(t.band.length).toBe(1000);
    expect(t.bandShare[499]).toBe(70);
    expect(t.bandShare[500]).toBe(20);
  });

  it("refuses a slice that was never captured", () => {
    const t = featureTimeline([capture(0, 10, () => true), capture(20, 10, () => true)]);
    expect(sliceFeatures(t, 0, 10)).not.toBeNull();
    expect(sliceFeatures(t, 5, 10)).toBeNull();
  });
});

describe("simulated chunks", () => {
  // Talk in 0–20 s, music (loud, not voiced) in 20–60 s, quiet in 60–80 s.
  const t = featureTimeline([
    capture(0, 20, () => true),
    capture(20, 40, () => false, -20),
    capture(60, 20, () => false, -70),
  ]);
  const truth = {
    speech: [{ start: 0, end: 20 }],
    lines: [
      { start: 1, end: 4 },
      { start: 12, end: 15 },
    ],
    anySpeech: [{ start: 0, end: 20 }],
    precision: true,
  };

  it("sends chunks with talk and skips the others", () => {
    const chunks = simulateChunks(t, 10);
    expect(chunks.length).toBe(71);
    expect(chunks.find((c) => c.start === 0)!.sent).toBe(true);
    expect(chunks.find((c) => c.start === 30)!.sent).toBe(false);
  });

  it("scores recall, music and quiet stretches, and precision", () => {
    const score = scoreChunks(t, simulateChunks(t, 10), truth, 10);
    // a chunk with only its first second of talk (19–29 s) is still sent (1 of 3 s voiced)
    expect(score.talkRecall).toBe(1);
    expect(score.linesEverSkipped).toBe(0);
    expect(score.lines).toBe(2);
    // no-speech chunks start at 21–70 s (0.5 s padding); those starting by 55 s are
    // mostly music (median loudness), the rest quiet
    expect(score.loudNoSpeech).toBe(35);
    expect(score.loudSkipped).toBe(35);
    expect(score.quietNoSpeech).toBe(15);
    expect(score.quietSkipped).toBe(15);
    expect(score.precision).toBe(1);
  });

  it("counts a line as skipped when some chunk around it was skipped", () => {
    const sparse = featureTimeline([capture(0, 40, (s) => s >= 10 && s < 10.5)]);
    const score = scoreChunks(
      sparse,
      simulateChunks(sparse, 10),
      { ...truth, lines: [{ start: 10, end: 10.5 }] },
      10,
    );
    expect(score.linesEverSkipped).toBe(1);
    expect(score.lineRecall).toBeLessThan(1);
  });
});
