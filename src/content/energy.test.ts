import { describe, expect, it } from "vitest";
import { FLOOR_DB, energyEnvelope, findQuietCut, isNearFloor } from "./energy";

describe("energyEnvelope", () => {
  it("gives the RMS loudness of each frame in dBFS", () => {
    const rate = 1000;
    const samples = new Float32Array(rate); // 1 s: half silence, half a full-scale square wave
    for (let i = 500; i < 1000; i++) samples[i] = i % 2 ? 1 : -1;
    const envelope = energyEnvelope(samples, rate, 0.1);
    expect(envelope).toEqual([...Array(5).fill(FLOOR_DB), ...Array(5).fill(0)]);
  });
});

describe("findQuietCut", () => {
  // 20 ms frames: loud speech (-20 dB) with pauses (-60 dB) at 4.0–4.4 s and 9.0–9.6 s.
  const envelope = Array.from({ length: 600 }, (_, i) => {
    const t = i * 0.02;
    return (t >= 4 && t < 4.4) || (t >= 9 && t < 9.6) ? -60 : -20;
  });

  it("cuts inside the pause closest to the target", () => {
    const { time, db } = findQuietCut(envelope, 10, 3, 11);
    expect(time).toBeGreaterThanOrEqual(9.1);
    expect(time).toBeLessThanOrEqual(9.5);
    expect(db).toBe(-60);
    const early = findQuietCut(envelope, 5, 3, 11);
    expect(early.time).toBeGreaterThanOrEqual(4.1);
    expect(early.time).toBeLessThanOrEqual(4.3);
  });

  it("stays inside the allowed range", () => {
    const { time } = findQuietCut(envelope, 7, 6, 8);
    expect(time).toBeGreaterThanOrEqual(6);
    expect(time).toBeLessThanOrEqual(8);
  });

  it("falls back to the target when the range is empty", () => {
    expect(findQuietCut([], 7, 6, 8).time).toBe(7);
  });
});

describe("isNearFloor", () => {
  it("compares with the quietest tenth of the envelope", () => {
    const envelope = [...Array(20).fill(-50), ...Array(80).fill(-20)];
    expect(isNearFloor(envelope, -52)).toBe(true);
    expect(isNearFloor(envelope, -45)).toBe(true);
    expect(isNearFloor(envelope, -40)).toBe(false);
    expect(isNearFloor([], -90)).toBe(false);
  });
});
