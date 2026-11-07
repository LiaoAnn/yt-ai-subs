// Voice activity detection without a model: spectral features per 20 ms frame of 16 kHz
// mono audio, and a decision per frame from them. Pure functions; no Web Audio here.
//
// Loudness alone cannot tell a voice from background music, which is just as loud. Speech
// keeps most of its energy in 300–3400 Hz and switches on and off with syllables a few
// times a second; music spreads wider and holds steadier. The thresholds are tuned on
// debug captures (see the test-extension-in-browser skill).

export const VOICE_FRAME_SECONDS = 0.02;
const FFT_SIZE = 512; // 32 ms at 16 kHz
const SPEECH_LOW_HZ = 300;
const SPEECH_HIGH_HZ = 3400;

/** In-place radix-2 FFT of (re, im); length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(angle * k);
        const sin = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * cos - im[b]! * sin;
        const ti = re[b]! * sin + im[b]! * cos;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

export interface VoiceFeatures {
  /** Energy in 300–3400 Hz per frame, dB (whole numbers, floor -100). */
  band: number[];
  /** Share of the frame's energy in 300–3400 Hz, percent. */
  bandShare: number[];
  /** Spectral flatness in 300–3400 Hz, percent (100 = noise-like, near 0 = tonal). */
  flatness: number[];
}

/** Spectral features per VOICE_FRAME_SECONDS frame. */
export function voiceFeatures(samples: Float32Array, sampleRate: number): VoiceFeatures {
  const hop = Math.round(sampleRate * VOICE_FRAME_SECONDS);
  const binHz = sampleRate / FFT_SIZE;
  const low = Math.ceil(SPEECH_LOW_HZ / binHz);
  const high = Math.floor(SPEECH_HIGH_HZ / binHz);
  const window = Float64Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
  );
  const out: VoiceFeatures = { band: [], bandShare: [], flatness: [] };
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let start = 0; start < samples.length; start += hop) {
    re.fill(0);
    im.fill(0);
    // Centre the analysis window on the frame.
    const from = start + hop / 2 - FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[from + i];
      re[i] = s === undefined ? 0 : s * window[i]!;
    }
    fft(re, im);
    let total = 0;
    let band = 0;
    let logSum = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const power = re[k]! * re[k]! + im[k]! * im[k]!;
      total += power;
      if (k >= low && k <= high) {
        band += power;
        logSum += Math.log(power + 1e-12);
      }
    }
    const bins = high - low + 1;
    const scale = (FFT_SIZE * FFT_SIZE) / 4; // power of a full-scale sine ≈ 0 dB
    out.band.push(Math.max(-100, Math.round(10 * Math.log10(band / scale + 1e-10))));
    out.bandShare.push(total > 0 ? Math.round((100 * band) / total) : 0);
    const geometric = Math.exp(logSum / bins);
    const arithmetic = band / bins;
    const flatness = arithmetic > 1e-9 ? (100 * geometric) / arithmetic : 100;
    out.flatness.push(Math.min(100, Math.round(flatness)));
  }
  return out;
}

/** A frame looks voiced when the speech band dominates and the spectrum is not noise-like. */
const VOICED_MIN_SHARE = 45;
const VOICED_MAX_FLATNESS = 30;
/** Window over which voiced frames are counted (seconds). */
const VOICE_WINDOW_SECONDS = 3;
/**
 * A chunk is sent only if some window has at least this share of voiced frames. Tuned on six
 * videos: talk (news, variety, idol talk) never scored below 0.51, BGM-only stretches of
 * vlogs scored 0.24–0.45.
 */
export const MIN_VOICED_SHARE = 0.45;

/** The highest share of voiced frames in any VOICE_WINDOW_SECONDS window (0–1). */
export function bestVoicedWindow(features: VoiceFeatures): number {
  const voiced = features.bandShare.map((share, i) =>
    share >= VOICED_MIN_SHARE && features.flatness[i]! <= VOICED_MAX_FLATNESS ? 1 : 0,
  );
  const width = Math.round(VOICE_WINDOW_SECONDS / VOICE_FRAME_SECONDS);
  if (voiced.length <= width) {
    return voiced.length ? voiced.reduce<number>((a, b) => a + b, 0) / voiced.length : 0;
  }
  let sum = voiced.slice(0, width).reduce<number>((a, b) => a + b, 0);
  let best = sum;
  for (let i = width; i < voiced.length; i++) {
    sum += voiced[i]! - voiced[i - width]!;
    best = Math.max(best, sum);
  }
  return best / width;
}
