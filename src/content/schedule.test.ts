import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  forPlaybackRate,
  isFinished,
  isIrrelevant,
  leadSeconds,
  nextNeeded,
  trimCutSentence,
  type Job,
} from "./schedule";

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
    expect(nextNeeded([], 0, 600, NOW)).toEqual({ start: 0, end: 10, flexible: true });
    expect(nextNeeded([], 45.6, 600, NOW)).toEqual({ start: 44, end: 54, flexible: true });
  });

  it("continues with chunks of chunkSeconds from wherever the last one ended", () => {
    expect(nextNeeded([done(0, 10)], 2, 600, NOW)).toEqual({ start: 10, end: 40, flexible: true });
    expect(nextNeeded([done(0, 10), done(10, 37.3)], 2, 600, NOW)).toEqual({
      start: 37.3,
      end: 67.3,
      flexible: true,
    });
  });

  it("waits while the chunk before has no final end", () => {
    expect(
      nextNeeded([{ ...done(0, 10), status: "running", flexible: true }], 2, 600, NOW),
    ).toBeNull();
  });

  it("stops at the lookahead", () => {
    expect(nextNeeded([done(0, 10), done(10, 40)], 2, 600, NOW)).toEqual({
      start: 40,
      end: 70,
      flexible: true,
    });
    expect(nextNeeded([done(0, 10), done(10, 40), done(40, 70)], 2, 600, NOW)).toBeNull();
  });

  it("never leaves a tiny chunk before the video end", () => {
    expect(nextNeeded([done(0, 10)], 2, 45, NOW)).toEqual({ start: 10, end: 45, flexible: false });
    expect(nextNeeded([done(0, 10)], 2, 20, NOW)).toEqual({ start: 10, end: 20, flexible: false });
  });

  it("does not overlap a later job", () => {
    expect(nextNeeded([done(0, 10), done(20, 30)], 2, 600, NOW)).toEqual({
      start: 10,
      end: 20,
      flexible: false,
    });
  });

  it("does not overlap a finished job before the playhead after a seek", () => {
    expect(nextNeeded([done(0, 30)], 30.5, 600, NOW)).toEqual({
      start: 30,
      end: 40,
      flexible: true,
    });
  });

  it("re-checks a skipped range (no audio, not a failed try) after its recheck time", () => {
    const skipped: Job = { start: 10, end: 40, status: "error", tries: 0, retryAt: NOW + 5000 };
    expect(nextNeeded([done(0, 10), skipped], 2, 600, NOW)).toEqual({
      start: 40,
      end: 70,
      flexible: true,
    });
    expect(nextNeeded([done(0, 10), skipped], 2, 600, NOW + 5000)).toEqual({
      start: 10,
      end: 40,
      flexible: false,
      retry: skipped,
    });
  });

  it("retries errored jobs after their backoff, at most maxTries times", () => {
    const failed: Job = { start: 0, end: 10, status: "error", tries: 1, retryAt: NOW + 5000 };
    // Still backing off: the scheduler moves on to the next chunk.
    expect(nextNeeded([failed], 0, 600, NOW)).toEqual({ start: 10, end: 40, flexible: true });
    expect(nextNeeded([failed], 0, 600, NOW + 6000)).toEqual({
      start: 0,
      end: 10,
      flexible: false,
      retry: failed,
    });
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

describe("leadSeconds", () => {
  it("counts finished chunks contiguous from the playhead", () => {
    const jobs = [done(0, 10), done(10, 40), { ...done(40, 70), status: "running" as const }];
    expect(leadSeconds(jobs, 5)).toBe(35);
    expect(leadSeconds(jobs, 45)).toBe(0);
    expect(leadSeconds([done(0, 10), done(20, 30)], 2)).toBe(8);
    expect(leadSeconds([], 2)).toBe(0);
  });
});

describe("forPlaybackRate", () => {
  it("scales the lookahead with faster playback, capped, and never shrinks it", () => {
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 1)).toBe(DEFAULT_SCHEDULE);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 0.5)).toBe(DEFAULT_SCHEDULE);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, Number.NaN)).toBe(DEFAULT_SCHEDULE);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 1.5).lookaheadSeconds).toBe(90);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 2).lookaheadSeconds).toBe(120);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 16).lookaheadSeconds).toBe(240);
    expect(forPlaybackRate(DEFAULT_SCHEDULE, 2).chunkSeconds).toBe(DEFAULT_SCHEDULE.chunkSeconds);
  });

  it("schedules further ahead and keeps running jobs relevant at 2x", () => {
    const jobs = [done(0, 10), done(10, 40), done(40, 70)];
    expect(nextNeeded(jobs, 5, 600, NOW)).toBeNull(); // 1x: 65 s ahead is enough
    expect(nextNeeded(jobs, 5, 600, NOW, forPlaybackRate(DEFAULT_SCHEDULE, 2))).toEqual({
      start: 70,
      end: 100,
      flexible: true,
    });
    const far = { start: 100, end: 130 };
    expect(isIrrelevant(far, 5)).toBe(true);
    expect(isIrrelevant(far, 5, forPlaybackRate(DEFAULT_SCHEDULE, 2))).toBe(false);
  });
});
