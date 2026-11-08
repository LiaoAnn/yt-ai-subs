import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import {
  CACHE_MAX_AGE_MS,
  CACHE_MAX_ENTRIES,
  CACHE_META_PREFIX,
  CACHE_PREFIX,
  LEGACY_INDEX_KEY,
  cacheKey,
  evict,
  isExpired,
  loadCache,
  metaKeyOf,
  saveCache,
  selectEvictions,
  type CacheEntry,
  type CacheStorage,
} from "./cache";
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

  it("keeps lines from a creator track apart from Whisper's", () => {
    const creator = cacheKey("vid", DEFAULT_SETTINGS, "ja");
    expect(creator).toBe("cache:vid:creator:ja:openai/gpt-oss-120b:zh-TW");
    expect(creator).not.toBe(cacheKey("vid", DEFAULT_SETTINGS));
    // The Whisper model does not shape a creator track's lines.
    expect(
      cacheKey("vid", { ...DEFAULT_SETTINGS, whisperModel: "whisper-large-v3-turbo" }, "ja"),
    ).toBe(creator);
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
    expect(selectEvictions({ "cache:nan": Number.NaN }, now)).toEqual(["cache:nan"]);
  });
});

/**
 * chrome.storage.local stand-in: every call resolves after a few ticks, so concurrent
 * saves (two tabs) interleave between their reads and writes.
 */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  let calls = 0;
  const later = async () => {
    const ticks = (calls++ * 7) % 4;
    for (let i = 0; i <= ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const storage: CacheStorage = {
    async get(keys) {
      await later();
      const list = keys === null ? [...data.keys()] : typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items) {
      await later();
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      await later();
      for (const k of typeof keys === "string" ? [keys] : keys) data.delete(k);
    },
    async getKeys(): Promise<string[]> {
      await later();
      return [...data.keys()];
    },
  };
  return { storage, data };
}

const entry = (savedAt: number): CacheEntry => ({
  chunks: [{ start: 0, end: 30 }],
  cues: [{ start: 1, end: 2, original: "テスト" }],
  savedAt,
});

const entryKeys = (data: Map<string, unknown>) =>
  [...data.keys()].filter((k) => k.startsWith(CACHE_PREFIX)).toSorted();
const metaKeys = (data: Map<string, unknown>) =>
  [...data.keys()].filter((k) => k.startsWith(CACHE_META_PREFIX)).toSorted();

describe("saveCache with several tabs", () => {
  it("loses no entry when two tabs save at the same time", async () => {
    const { storage, data } = fakeStorage();
    const now = Date.now();
    await Promise.all([
      saveCache("cache:a:x", entry(now), storage),
      saveCache("cache:b:x", entry(now + 1), storage),
    ]);
    expect(entryKeys(data)).toEqual(["cache:a:x", "cache:b:x"]);
    expect(metaKeys(data)).toEqual([metaKeyOf("cache:a:x"), metaKeyOf("cache:b:x")]);
    expect(await loadCache("cache:a:x", storage)).toEqual(entry(now));
  });

  it("keeps exactly the newest entries, each with its meta, under concurrent saves", async () => {
    const { storage, data } = fakeStorage();
    const now = Date.now();
    const count = CACHE_MAX_ENTRIES + 12;
    await Promise.all(
      Array.from({ length: count }, (_, i) => saveCache(`cache:v${i}:x`, entry(now + i), storage)),
    );
    const kept = entryKeys(data);
    expect(kept).toHaveLength(CACHE_MAX_ENTRIES);
    expect(kept).not.toContain("cache:v0:x");
    expect(kept).toContain(`cache:v${count - 1}:x`);
    // No orphans either way: every entry has its meta key and every meta key its entry.
    expect(metaKeys(data)).toEqual(kept.map(metaKeyOf).toSorted());
  });

  it("rebuilds meta keys for entries saved by older versions and drops the shared index", async () => {
    const now = Date.now();
    const { storage, data } = fakeStorage({
      "cache:old:x": entry(now - 1000),
      "cache:orphan:x": entry(now - 2000), // missing from the old index (lost update)
      "cache:broken:x": { chunks: [], cues: [] }, // no savedAt: cannot be trusted
      "cache:expired:x": entry(now - CACHE_MAX_AGE_MS - 1),
      [LEGACY_INDEX_KEY]: { "cache:old:x": now - 1000 },
      settings: { enabled: true },
    });
    await evict(now, storage);
    expect(entryKeys(data)).toEqual(["cache:old:x", "cache:orphan:x"]);
    expect(metaKeys(data)).toEqual([metaKeyOf("cache:old:x"), metaKeyOf("cache:orphan:x")]);
    expect(data.has(LEGACY_INDEX_KEY)).toBe(false);
    expect(data.has("settings")).toBe(true);
  });
});

describe("cache edge cases", () => {
  it("keeps an entry another tab saved again while eviction was deciding", async () => {
    const now = Date.now();
    const initial: Record<string, unknown> = {};
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) {
      initial[`cache:v${i}:x`] = entry(now - 1000 + i);
      initial[metaKeyOf(`cache:v${i}:x`)] = now - 1000 + i;
    }
    const { storage, data } = fakeStorage(initial);
    const get = storage.get.bind(storage);
    let refreshed = false;
    storage.get = async (keys) => {
      const result = await get(keys);
      // Right after eviction read the meta keys, another tab saves v0 (the oldest) again.
      if (!refreshed && Array.isArray(keys) && keys.includes(metaKeyOf("cache:v0:x"))) {
        refreshed = true;
        data.set("cache:v0:x", entry(now + 5));
        data.set(metaKeyOf("cache:v0:x"), now + 5);
      }
      return result;
    };
    await evict(now, storage);
    expect(data.get("cache:v0:x")).toEqual(entry(now + 5));
    expect(data.get(metaKeyOf("cache:v0:x"))).toBe(now + 5);
  });

  it("works without storage.getKeys (Chrome before 130)", async () => {
    const { storage, data } = fakeStorage();
    delete storage.getKeys;
    const now = Date.now();
    for (let i = 0; i < CACHE_MAX_ENTRIES + 2; i++) {
      await saveCache(`cache:v${i}:x`, entry(now + i), storage);
    }
    expect(entryKeys(data)).toHaveLength(CACHE_MAX_ENTRIES);
    expect(data.has("cache:v0:x")).toBe(false);
  });

  it("evicts and retries when the storage area is full", async () => {
    const now = Date.now();
    const initial: Record<string, unknown> = {};
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) {
      initial[`cache:v${i}:x`] = entry(now - CACHE_MAX_AGE_MS * 2); // all expired
      initial[metaKeyOf(`cache:v${i}:x`)] = now - CACHE_MAX_AGE_MS * 2;
    }
    const { storage, data } = fakeStorage(initial);
    const set = storage.set.bind(storage);
    // A storage area that holds at most CACHE_MAX_ENTRIES entries (plus their meta keys).
    storage.set = async (items) => {
      const adding = Object.keys(items).filter((k) => k.startsWith(CACHE_PREFIX) && !data.has(k));
      if (entryKeys(data).length + adding.length > CACHE_MAX_ENTRIES) {
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      await set(items);
    };
    await saveCache("cache:new:x", entry(now), storage);
    expect(entryKeys(data)).toEqual(["cache:new:x"]);
  });
});

const jsonSize = (items: Map<string, unknown>) =>
  [...items].reduce((sum, [k, v]) => sum + k.length + JSON.stringify(v).length, 0);

/** A storage area that holds at most `limit` bytes of JSON, like chrome.storage.local. */
function limitedStorage(limit: number, initial: Record<string, unknown>) {
  const fake = fakeStorage(initial);
  const set = fake.storage.set.bind(fake.storage);
  fake.storage.set = async (items) => {
    const next = new Map(fake.data);
    for (const [k, v] of Object.entries(items)) next.set(k, v);
    if (jsonSize(next) > limit) throw new Error("QUOTA_BYTES quota exceeded");
    await set(items);
  };
  return fake;
}

const bigEntry = (savedAt: number, cues: number): CacheEntry => ({
  chunks: [{ start: 0, end: cues * 3 }],
  cues: Array.from({ length: cues }, (_, i) => ({
    start: i * 3,
    end: i * 3 + 2,
    original: "長い動画の字幕です",
    translation: "長影片的字幕",
  })),
  savedAt,
});

describe("saveCache with a full storage area", () => {
  it("evicts only as many of the oldest entries as it takes, with few entries", async () => {
    const now = Date.now();
    const initial: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      initial[`cache:v${i}:x`] = bigEntry(now - 1000 + i, 400);
      initial[metaKeyOf(`cache:v${i}:x`)] = now - 1000 + i;
    }
    const perEntry = JSON.stringify(bigEntry(now, 400)).length;
    // Room for five and a half entries: a long video (two entries' worth) needs two
    // evictions (a first try with one is not enough).
    const { storage, data } = limitedStorage(perEntry * 5.5, initial);
    await saveCache("cache:long:x", bigEntry(now, 800), storage);
    expect(entryKeys(data)).toEqual(["cache:long:x", "cache:v2:x", "cache:v3:x", "cache:v4:x"]);
    expect(metaKeys(data)).toEqual(entryKeys(data).map(metaKeyOf).toSorted());
  });

  it("keeps an earlier copy of the entry being saved while it makes room", async () => {
    const now = Date.now();
    // The older copy of "long" is older than "other", but only "other" may go.
    const { storage, data } = limitedStorage(JSON.stringify(bigEntry(now, 500)).length * 2, {
      "cache:long:x": bigEntry(now - 10, 300),
      [metaKeyOf("cache:long:x")]: now - 10,
      "cache:other:x": bigEntry(now - 5, 500),
      [metaKeyOf("cache:other:x")]: now - 5,
    });
    await saveCache("cache:long:x", bigEntry(now, 600), storage);
    expect(entryKeys(data)).toEqual(["cache:long:x"]);
    expect((data.get("cache:long:x") as CacheEntry).cues).toHaveLength(600);
  });

  it("gives up when the entry does not fit even alone", async () => {
    const { storage, data } = limitedStorage(1000, {});
    await expect(saveCache("cache:huge:x", bigEntry(Date.now(), 100), storage)).rejects.toThrow(
      "QUOTA_BYTES",
    );
    expect(entryKeys(data)).toEqual([]);
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
