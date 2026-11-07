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

  it("handles audio shorter than the window", () => {
    expect(bestVoicedWindow(voiceFeatures(tone(1000, 1), RATE))).toBeGreaterThan(0.9);
    expect(bestVoicedWindow({ band: [], bandShare: [], flatness: [] })).toBe(0);
  });
});
