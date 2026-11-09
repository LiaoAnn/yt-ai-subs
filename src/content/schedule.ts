// Which stretch of audio to transcribe next. Pure logic over the current jobs.
//
// Chunks are about `chunkSeconds` long, except right after a start or seek: the chunk
// under the playhead is cut short (`firstChunkSeconds`) so captions appear fast. A chunk's
// end is only a target: the content script moves it to a quiet moment nearby once the
// audio is decoded (see findQuietCut), and nothing after it is scheduled until then.

import type { Cue } from "@/shared/captions";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  start: number;
  end: number;
  status: JobStatus;
  tries: number;
  /** For errored jobs: not before this time (ms since epoch). */
  retryAt: number;
  /** The end is still a target that may move; schedule nothing after it yet. */
  flexible?: boolean;
}

export interface ScheduleOptions {
  chunkSeconds: number;
  lookaheadSeconds: number;
  firstChunkSeconds: number;
  /** A chunk never leaves less than this before the video end. */
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

/** Rates above this are treated as this (YouTube offers up to 2×; extensions can go higher). */
export const MAX_RATE = 4;

/**
 * The schedule for playback at `rate`. The lookahead is in video seconds, but what keeps
 * captions ahead is wall time (decoding, Groq's latency): at 2× the playhead covers twice
 * the video per second, so the lookahead doubles. Slower than 1× keeps the 1× lookahead.
 */
export function forPlaybackRate(options: ScheduleOptions, rate: number): ScheduleOptions {
  const scale = Number.isFinite(rate) && rate > 1 ? Math.min(rate, MAX_RATE) : 1;
  return scale === 1 ? options : { ...options, lookaheadSeconds: options.lookaheadSeconds * scale };
}

const EPS = 0.05;

const live = (job: Job) => job.status !== "error";

/** Whether time `t` is inside a finished job (so its audio is no longer needed). */
export function isFinished(jobs: Iterable<Job>, t: number): boolean {
  for (const job of jobs) {
    if (job.status === "done" && job.start <= t + EPS && job.end > t + EPS) return true;
  }
  return false;
}

/**
 * Seconds of finished chunks ahead of playhead `t`, contiguous from `t` (0 when the
 * playhead itself is not covered). For diagnostics: how far captions are ahead.
 */
export function leadSeconds(jobs: Iterable<Job>, t: number): number {
  const done = [...jobs].filter((job) => job.status === "done");
  let cursor = t;
  for (;;) {
    const covering = done.find((job) => job.start <= cursor + EPS && job.end > cursor + EPS);
    if (!covering) return Math.max(0, cursor - t);
    cursor = covering.end;
  }
}

/** `flexible`: the end may move to a nearby quiet moment (not pinned by a job or the end). */
export type NextChunk = { start: number; end: number; flexible: boolean; retry?: Job };

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
      if (covering.flexible) return null; // its end is not known yet
      cursor = covering.end;
      continue;
    }
    let end = Math.min(cursor + C, duration);
    if (duration - end < minChunkSeconds) end = duration;
    let flexible = end < duration;
    for (const job of jobs) {
      if (live(job) && job.start > cursor && job.start < end) {
        end = job.start;
        flexible = false;
      }
    }
    let start = cursor;
    if (Math.abs(cursor - t) < 0.01) {
      // The playhead itself is uncovered: start a second early, without overlapping a
      // finished job, and keep the chunk short so the first caption comes quickly.
      start = Math.max(0, Math.floor(t) - 1);
      for (const job of jobs) {
        if (live(job) && job.end <= t + EPS && job.end > start) start = job.end;
      }
      if (end - start > firstChunkSeconds + 5) {
        end = start + firstChunkSeconds;
        flexible = true;
      }
    }
    const errored = jobs.find(
      (job) => job.status === "error" && job.start <= start + EPS && job.end > start + EPS,
    );
    if (errored) {
      if (errored.tries >= maxTries || now < errored.retryAt) {
        cursor = Math.max(errored.end, cursor + 0.5);
        continue;
      }
      return { start: errored.start, end: errored.end, flexible: false, retry: errored };
    }
    return { start, end, flexible };
  }
  return null;
}

/**
 * Whether a running job is no longer worth finishing for playhead `t`: the viewer is
 * past it, or it lies beyond what the scheduler would request now (after a seek back).
 */
/**
 * Whether a chunk whose audio is only partly buffered is sent now with what there is
 * (`haveSeconds` from its start), rather than waiting for more. Short requests cost as much
 * as 10 s ones, so only when the playhead is close, in wall seconds (a faster rate starts
 * them earlier): 8 s or more when the chunk starts within 6 s; 3 s or more when it starts
 * within 2 s and the playhead is within 3 s of the end of what is buffered. Without that
 * last condition a start sent the first 3–6 s YouTube had appended (2 of 4 runs once the
 * start no longer waited for the next tick), and a second request right after; YouTube
 * appends faster than real time at a start, so a tick later the whole first chunk is there.
 */
export function sendWhatIsBuffered(opts: {
  chunkStart: number;
  haveSeconds: number;
  playhead: number;
  rate: number;
}): boolean {
  const rate = Math.max(1, opts.rate);
  const margin = (opts.chunkStart - opts.playhead) / rate;
  const ahead = (opts.chunkStart + opts.haveSeconds - opts.playhead) / rate;
  return (
    (margin < 6 && opts.haveSeconds >= 8) || (margin < 2 && opts.haveSeconds >= 3 && ahead < 3)
  );
}

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
