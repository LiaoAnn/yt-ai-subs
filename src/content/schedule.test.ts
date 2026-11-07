import { describe, expect, it } from "vitest";
import { isFinished, isIrrelevant, nextNeeded, trimCutSentence, type Job } from "./schedule";

const done = (start: number, end: number): Job => ({
  start,
  end,
  status: "done",
  tries: 0,
  retryAt: 0,
});
const NOW = 1_000_000;

describe("nextNeeded", () => {
  it("starts with a short chunk a second before the playhead", () => {
    expect(nextNeeded([], 0, 600, NOW)).toEqual({ start: 0, end: 10 });
    expect(nextNeeded([], 45.6, 600, NOW)).toEqual({ start: 44, end: 54 });
  });

  it("continues on the 30 s grid after the first chunk", () => {
    expect(nextNeeded([done(0, 10)], 2, 600, NOW)).toEqual({ start: 10, end: 30 });
    expect(nextNeeded([done(0, 10), done(10, 30)], 2, 600, NOW)).toEqual({ start: 30, end: 60 });
  });

  it("stops at the lookahead", () => {
    expect(nextNeeded([done(0, 10), done(10, 30), done(30, 60)], 2, 600, NOW)).toEqual({
      start: 60,
      end: 90,
    });
    expect(
      nextNeeded([done(0, 10), done(10, 30), done(30, 60), done(60, 90)], 2, 600, NOW),
    ).toBeNull();
  });

  it("merges tiny leftovers into the next grid chunk and stops at the video end", () => {
    expect(nextNeeded([done(0, 25)], 2, 600, NOW)).toEqual({ start: 25, end: 60 });
    expect(nextNeeded([done(0, 10)], 2, 20, NOW)).toEqual({ start: 10, end: 20 });
  });

  it("does not overlap a later job", () => {
    expect(nextNeeded([done(0, 10), done(20, 30)], 2, 600, NOW)).toEqual({ start: 10, end: 20 });
  });

  it("does not overlap a finished job before the playhead after a seek", () => {
    expect(nextNeeded([done(0, 30)], 30.5, 600, NOW)).toEqual({ start: 30, end: 40 });
  });

  it("re-checks a skipped range (no audio, not a failed try) after its recheck time", () => {
    const skipped: Job = { start: 10, end: 30, status: "error", tries: 0, retryAt: NOW + 5000 };
    expect(nextNeeded([done(0, 10), skipped], 2, 600, NOW)).toEqual({ start: 30, end: 60 });
    expect(nextNeeded([done(0, 10), skipped], 2, 600, NOW + 5000)).toEqual({
      start: 10,
      end: 30,
      retry: skipped,
    });
  });

  it("retries errored jobs after their backoff, at most maxTries times", () => {
    const failed: Job = { start: 0, end: 10, status: "error", tries: 1, retryAt: NOW + 5000 };
    // Still backing off: the scheduler moves on to the next chunk.
    expect(nextNeeded([failed], 0, 600, NOW)).toEqual({ start: 10, end: 30 });
    expect(nextNeeded([failed], 0, 600, NOW + 6000)).toEqual({ start: 0, end: 10, retry: failed });
    const givenUp: Job = { ...failed, tries: 3, retryAt: 0 };
    expect(nextNeeded([givenUp], 0, 600, NOW)?.retry).toBeUndefined();
  });
});

describe("isFinished / isIrrelevant", () => {
  it("counts only finished jobs, not running (possibly cancelled) ones", () => {
    expect(isFinished([done(0, 10)], 5)).toBe(true);
    expect(isFinished([{ ...done(0, 10), status: "running" }], 5)).toBe(false);
    expect(isFinished([{ ...done(0, 10), status: "error" }], 5)).toBe(false);
  });

  it("flags jobs behind the playhead or far beyond the lookahead", () => {
    expect(isIrrelevant({ start: 0, end: 10 }, 30)).toBe(true);
    expect(isIrrelevant({ start: 200, end: 230 }, 10)).toBe(true);
    expect(isIrrelevant({ start: 30, end: 60 }, 25)).toBe(false);
  });
});

describe("trimCutSentence", () => {
  const cues = [
    { start: 0.5, end: 4, original: "a" },
    { start: 26, end: 29.8, original: "b" },
  ];

  it("drops a last line that runs into the end of the chunk", () => {
    expect(trimCutSentence(cues, 30, true)).toEqual({ cues: [cues[0]], newLength: 25.95 });
  });

  it("keeps everything when trimming is not allowed or the line ends in time", () => {
    expect(trimCutSentence(cues, 30, false)).toBeNull();
    expect(trimCutSentence([cues[0]!, { ...cues[1]!, end: 28 }], 30, true)).toBeNull();
    expect(trimCutSentence([cues[1]!], 30, true)).toBeNull();
  });
});
