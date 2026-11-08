import { describe, expect, it } from "vitest";
import { MIN_VOICED_SHARE, bestVoicedWindow, voiceFeatures } from "./voice";

const RATE = 16_000;
const tone = (hz: number, seconds: number) =>
  Float32Array.from(
    { length: RATE * seconds },
    (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / RATE),
  );
// Deterministic white noise.
const noise = (seconds: number) => {
  let x = 1;
  return Float32Array.from({ length: RATE * seconds }, () => {
    x = (x * 16_807) % 2_147_483_647;
    return (x / 2_147_483_647 - 0.5) * 0.6;
  });
};
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// A low voice whose fundamental (here 180 Hz) carries most of its energy, below the
// 300–3400 Hz band: only 12% of the energy is in the band (cth3M1iavGM, a male voice with
// its audio high-passed at 150 Hz, had 36% in the band while speaking).
const lowVoice = (seconds: number, held = false) =>
  Float32Array.from({ length: RATE * seconds }, (_, i) => {
    const t = i / RATE;
    // Syllables: 150 ms on, 100 ms off; `held` keeps the sound on (music, a hum).
    const on = held || t % 0.25 < 0.15 ? 1 : 0;
    return (
      on *
      (0.3 * Math.sin(2 * Math.PI * 180 * t) +
        0.1 * Math.sin(2 * Math.PI * 360 * t) +
        0.05 * Math.sin(2 * Math.PI * 540 * t))
    );
  });

describe("voiceFeatures", () => {
  it("gives one frame per 20 ms with the speech-band share and flatness", () => {
    const f = voiceFeatures(tone(1000, 1), RATE);
    expect(f.band.length).toBe(50);
    expect(Math.min(...f.bandShare.slice(1, -1))).toBeGreaterThan(90);
    expect(Math.max(...f.flatness.slice(1, -1))).toBeLessThan(10);
    expect(Math.max(...voiceFeatures(tone(100, 1), RATE).bandShare.slice(1, -1))).toBeLessThan(10);
    expect(Math.min(...voiceFeatures(noise(1), RATE).flatness.slice(1, -1))).toBeGreaterThan(30);
  });
});

describe("bestVoicedWindow", () => {
  it("finds a few seconds of voice-like sound among noise and low hum", () => {
    expect(
      bestVoicedWindow(voiceFeatures(concat(noise(4), tone(1000, 3), tone(80, 4)), RATE)),
    ).toBeGreaterThan(0.9);
    expect(bestVoicedWindow(voiceFeatures(concat(noise(5), tone(80, 5)), RATE))).toBeLessThan(
      MIN_VOICED_SHARE,
    );
  });

  it("finds a low voice whose energy is mostly below 300 Hz", () => {
    const f = voiceFeatures(lowVoice(4), RATE);
    expect(Math.max(...f.bandShare)).toBeLessThan(45);
    expect(bestVoicedWindow(f)).toBeGreaterThanOrEqual(MIN_VOICED_SHARE);
  });

  it("does not take a held low sound for a voice", () => {
    expect(bestVoicedWindow(voiceFeatures(lowVoice(4, true), RATE))).toBeLessThan(MIN_VOICED_SHARE);
  });

  it("finds syllables over bass (talk over music)", () => {
    const withBass = lowVoice(4).map((s, i) => s + 0.6 * Math.sin((2 * Math.PI * 70 * i) / RATE));
    expect(bestVoicedWindow(voiceFeatures(withBass, RATE))).toBeGreaterThanOrEqual(
      MIN_VOICED_SHARE,
    );
  });

  it("finds a quiet voice over steady noise, but not the noise alone", () => {
    const hiss = noise(4).map((s) => s * 0.3);
    const quiet = lowVoice(4).map((s, i) => 0.3 * s + hiss[i]! * 0.1);
    expect(bestVoicedWindow(voiceFeatures(quiet, RATE))).toBeGreaterThanOrEqual(MIN_VOICED_SHARE);
    expect(bestVoicedWindow(voiceFeatures(hiss, RATE))).toBeLessThan(MIN_VOICED_SHARE);
  });

  it("does not take near-silence that flickers for a voice", () => {
    const faint = lowVoice(4).map((s) => s * 0.0003);
    expect(bestVoicedWindow(voiceFeatures(faint, RATE))).toBeLessThan(MIN_VOICED_SHARE);
  });

  it("handles audio shorter than the window", () => {
    expect(bestVoicedWindow(voiceFeatures(tone(1000, 1), RATE))).toBeGreaterThan(0.9);
    expect(bestVoicedWindow({ band: [], bandShare: [], flatness: [] })).toBe(0);
  });
});
