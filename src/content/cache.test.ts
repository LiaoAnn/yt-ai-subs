import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import { CACHE_MAX_AGE_MS, cacheKey, isExpired, selectEvictions } from "./cache";
import { bytesToBase64, encodeWav } from "./wav";

describe("cacheKey", () => {
  it("separates settings that change the captions", () => {
    const translated = cacheKey("vid", DEFAULT_SETTINGS);
    const transcribeOnly = cacheKey("vid", { ...DEFAULT_SETTINGS, translate: false });
    const otherModel = cacheKey("vid", {
      ...DEFAULT_SETTINGS,
      whisperModel: "whisper-large-v3-turbo",
    });
    expect(new Set([translated, transcribeOnly, otherModel]).size).toBe(3);
    expect(transcribeOnly).toBe("cache:vid:whisper-large-v3:ja:none");
    // Settings that only change the display share the entry.
    expect(cacheKey("vid", { ...DEFAULT_SETTINGS, showOriginal: false })).toBe(translated);
    // Dry runs (no captions) never share an entry with real captions.
    expect(
      cacheKey("vid", { ...DEFAULT_SETTINGS, debugCapture: true, debugDryRun: true }),
    ).not.toBe(translated);
    expect(cacheKey("vid", { ...DEFAULT_SETTINGS, debugDryRun: true })).toBe(translated);
  });
});

describe("selectEvictions", () => {
  it("evicts expired entries and the oldest beyond the limit", () => {
    const now = CACHE_MAX_AGE_MS * 2;
    const index = {
      "cache:old": now - CACHE_MAX_AGE_MS - 1,
      "cache:a": now - 3,
      "cache:b": now - 2,
      "cache:c": now - 1,
    };
    expect(selectEvictions(index, now, 2).toSorted()).toEqual(["cache:a", "cache:old"]);
    expect(selectEvictions(index, now, 10)).toEqual(["cache:old"]);
    expect(selectEvictions({}, now)).toEqual([]);
  });
});

describe("isExpired", () => {
  it("rejects entries older than the maximum age, or without a valid time", () => {
    expect(isExpired({ savedAt: 1000 }, 1000 + CACHE_MAX_AGE_MS)).toBe(false);
    expect(isExpired({ savedAt: 1000 }, 1001 + CACHE_MAX_AGE_MS)).toBe(true);
    expect(isExpired({ savedAt: Number.NaN }, 0)).toBe(true);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header and clamps samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  it("round-trips through base64", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});
