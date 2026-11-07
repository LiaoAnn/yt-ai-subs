// Which stretch of audio to transcribe next. Pure logic over the current jobs.
//
// Chunks follow a fixed grid of `chunkSeconds`, except right after a start or seek: the
// chunk under the playhead is cut short (`firstChunkSeconds`) so captions appear fast.

import type { Cue } from "@/shared/captions";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  start: number;
  end: number;
  status: JobStatus;
  tries: number;
  /** For errored jobs: not before this time (ms since epoch). */
  retryAt: number;
}

export interface ScheduleOptions {
  chunkSeconds: number;
  lookaheadSeconds: number;
  firstChunkSeconds: number;
  /** Leftovers shorter than this are merged into the next grid chunk. */
  minChunkSeconds: number;
  maxTries: number;
}

export const DEFAULT_SCHEDULE: ScheduleOptions = {
  chunkSeconds: 30,
  lookaheadSeconds: 60,
  firstChunkSeconds: 10,
  minChunkSeconds: 8,
  maxTries: 3,
};

const EPS = 0.05;

const live = (job: Job) => job.status !== "error";

/** Whether time `t` is inside a finished job (so its audio is no longer needed). */
export function isFinished(jobs: Iterable<Job>, t: number): boolean {
  for (const job of jobs) {
    if (job.status === "done" && job.start <= t + EPS && job.end > t + EPS) return true;
  }
  return false;
}

export type NextChunk = { start: number; end: number; retry?: Job };

/**
 * The next chunk to send for playhead `t`, or null if everything up to the lookahead is
 * covered (or waiting for a retry). `retry` is set when an errored job should run again.
 */
export function nextNeeded(
  jobs: readonly Job[],
  t: number,
  duration: number,
  now: number,
  options: ScheduleOptions = DEFAULT_SCHEDULE,
): NextChunk | null {
  const {
    chunkSeconds: C,
    lookaheadSeconds,
    firstChunkSeconds,
    minChunkSeconds,
    maxTries,
  } = options;
  const limit = Math.min(t + lookaheadSeconds, duration);
  let cursor = t;
  while (cursor < limit - 0.5) {
    const covering = jobs.find(
      (job) => live(job) && job.start <= cursor + EPS && job.end > cursor + EPS,
    );
    if (covering) {
      cursor = covering.end;
      continue;
    }
    const gridEnd = (Math.floor(cursor / C + 1e-6) + 1) * C;
    let end = Math.min(gridEnd, duration);
    if (end - cursor < minChunkSeconds) end = Math.min(gridEnd + C, duration);
    for (const job of jobs) if (live(job) && job.start > cursor && job.start < end) end = job.start;
    let start = cursor;
    if (Math.abs(cursor - t) < 0.01) {
      // The playhead itself is uncovered: start a second early, without overlapping a
      // finished job, and keep the chunk short so the first caption comes quickly.
      start = Math.max(0, Math.floor(t) - 1);
      for (const job of jobs) {
        if (live(job) && job.end <= t + EPS && job.end > start) start = job.end;
      }
      if (end - start > firstChunkSeconds + 5) end = start + firstChunkSeconds;
    }
    const errored = jobs.find(
      (job) => job.status === "error" && job.start <= start + EPS && job.end > start + EPS,
    );
    if (errored) {
      if (errored.tries >= maxTries || now < errored.retryAt) {
        cursor = Math.max(errored.end, cursor + 0.5);
        continue;
      }
      return { start: errored.start, end: errored.end, retry: errored };
    }
    return { start, end };
  }
  return null;
}

/**
 * Whether a running job is no longer worth finishing for playhead `t`: the viewer is
 * past it, or it lies beyond what the scheduler would request now (after a seek back).
 */
export function isIrrelevant(
  job: Pick<Job, "start" | "end">,
  t: number,
  options: ScheduleOptions = DEFAULT_SCHEDULE,
): boolean {
  return job.end < t - 1 || job.start > t + options.lookaheadSeconds + options.chunkSeconds;
}

/**
 * If the last line runs into the end of the chunk, the sentence was probably cut in half:
 * drop it so the next chunk starts where it began. Returns the kept cues (relative times)
 * and the new chunk length, or null when nothing is trimmed.
 */
export function trimCutSentence(
  cues: readonly Cue[],
  chunkSeconds: number,
  canTrim: boolean,
): { cues: Cue[]; newLength: number } | null {
  const sorted = cues.toSorted((a, b) => a.start - b.start);
  const last = sorted.at(-1);
  if (!canTrim || !last || sorted.length < 2) return null;
  if (last.end <= chunkSeconds - 0.6 || last.start <= 3) return null;
  return { cues: sorted.slice(0, -1), newLength: Math.round((last.start - 0.05) * 100) / 100 };
}
