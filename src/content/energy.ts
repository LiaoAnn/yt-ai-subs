// Loudness over time, for choosing chunk cuts in quiet places and for offline timing
// evaluation. Pure functions over decoded samples; no Web Audio here.

/** Length of one envelope frame (seconds). */
export const FRAME_SECONDS = 0.02;
/** Envelope floor (dBFS): digital silence and anything quieter. */
export const FLOOR_DB = -100;

/** RMS loudness per frame in whole dBFS, at least FLOOR_DB. */
export function energyEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameSeconds = FRAME_SECONDS,
): number[] {
  const frame = Math.max(1, Math.round(sampleRate * frameSeconds));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    const stop = Math.min(samples.length, i + frame);
    let sum = 0;
    for (let j = i; j < stop; j++) sum += samples[j]! * samples[j]!;
    const rms = Math.sqrt(sum / (stop - i));
    out.push(Math.max(FLOOR_DB, Math.round(20 * Math.log10(rms || 1e-10))));
  }
  return out;
}

/** Mean loudness (dB, averaged as power) of frames [from, to). */
function windowDb(envelope: readonly number[], from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(envelope.length, to); i++) {
    sum += 10 ** (envelope[i]! / 10);
    count++;
  }
  return count ? 10 * Math.log10(sum / count || 1e-10) : 0;
}

export interface QuietCutOptions {
  /** Width of the window whose loudness is compared (seconds). */
  windowSeconds?: number;
  /** Windows within this many dB of the quietest count as equally good. */
  toleranceDb?: number;
  frameSeconds?: number;
}

/**
 * The time (seconds from the envelope's start) in [from, to] where a cut hurts least: the
 * centre of the quietest window, preferring the one closest to `target` among windows
 * nearly as quiet. Returns `target` when the range has no frames.
 */
export function findQuietCut(
  envelope: readonly number[],
  target: number,
  from: number,
  to: number,
  { windowSeconds = 0.3, toleranceDb = 3, frameSeconds = FRAME_SECONDS }: QuietCutOptions = {},
): { time: number; db: number } {
  const half = Math.max(1, Math.round(windowSeconds / frameSeconds / 2));
  const first = Math.max(half, Math.ceil(from / frameSeconds));
  const last = Math.min(envelope.length - half, Math.floor(to / frameSeconds));
  if (last < first) return { time: target, db: 0 };
  const scores: { frame: number; db: number }[] = [];
  for (let frame = first; frame <= last; frame++) {
    scores.push({ frame, db: windowDb(envelope, frame - half, frame + half) });
  }
  const quietest = Math.min(...scores.map((s) => s.db));
  let best = scores[0]!;
  let bestDistance = Infinity;
  for (const score of scores) {
    if (score.db > quietest + toleranceDb) continue;
    const distance = Math.abs(score.frame * frameSeconds - target);
    if (distance < bestDistance) {
      best = score;
      bestDistance = distance;
    }
  }
  return { time: best.frame * frameSeconds, db: Math.round(best.db) };
}

/**
 * Whether loudness `db` is about as quiet as the envelope gets (within `marginDb` of its
 * 10th percentile): a cut there falls in a real pause, not between two words.
 */
export function isNearFloor(envelope: readonly number[], db: number, marginDb = 6): boolean {
  if (!envelope.length) return false;
  const sorted = envelope.toSorted((a, b) => a - b);
  return db <= sorted[Math.floor(sorted.length / 10)]! + marginDb;
}
