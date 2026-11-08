// Finished captions per video, in chrome.storage.local, so re-watching costs nothing.
//
// Several tabs save at the same time, so nothing here is a shared read-modify-write value:
// each entry has a small meta key of its own (`cachemeta:…` -> savedAt), written and removed
// together with the entry in one storage call. Eviction lists the meta keys and removes
// expired entries and the oldest beyond a fixed count. An entry without a meta key (saved
// by an older version, which kept one shared `cacheIndex`) gets one rebuilt from its own
// savedAt, so no entry is ever left behind.

import type { Cue } from "@/shared/captions";
import type { Glossary } from "@/shared/glossary";
import type { Settings } from "@/shared/settings";

export interface CachedChunk {
  start: number;
  end: number;
}

export interface CacheEntry {
  chunks: CachedChunk[];
  cues: Cue[];
  /** The video's translation glossary (missing in entries from older versions). */
  glossary?: Glossary;
  savedAt: number;
}

/** Storage key -> savedAt (ms). */
export type CacheIndex = Record<string, number>;

export const CACHE_PREFIX = "cache:";
export const CACHE_META_PREFIX = "cachemeta:";
/** The shared index older versions kept; used once to rebuild meta keys, then removed. */
export const LEGACY_INDEX_KEY = "cacheIndex";
export const CACHE_MAX_ENTRIES = 50;
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const metaKeyOf = (key: string) => CACHE_META_PREFIX + key.slice(CACHE_PREFIX.length);
const entryKeyOf = (metaKey: string) => CACHE_PREFIX + metaKey.slice(CACHE_META_PREFIX.length);

/** The parts of chrome.storage.local the cache uses (tests pass a fake). */
export interface CacheStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Chrome 130+; older versions list the keys by reading everything. */
  getKeys?(): Promise<string[]>;
}

async function listKeys(storage: CacheStorage): Promise<string[]> {
  if (typeof storage.getKeys === "function") return storage.getKeys();
  return Object.keys(await storage.get(null));
}

const local = (): CacheStorage => chrome.storage.local;

/**
 * One cache entry per video and per setting that changes the captions. With
 * `creatorLanguage`, the lines come from the creator's own track in that language instead
 * of Whisper (only the translation is cached work).
 */
export function cacheKey(videoId: string, settings: Settings, creatorLanguage?: string): string {
  const translation = settings.translate
    ? `${settings.translationModel}:${settings.targetLanguage}`
    : "none";
  // A dry run (development) produces no captions: keep it apart from the real entry.
  const dry = settings.debugCapture && settings.debugDryRun ? ":dry-run" : "";
  const lines = creatorLanguage
    ? `creator:${creatorLanguage}`
    : `${settings.whisperModel}:${settings.sourceLanguage}`;
  return `${CACHE_PREFIX}${videoId}:${lines}:${translation}${dry}`;
}

export function isExpired(entry: Pick<CacheEntry, "savedAt">, now: number): boolean {
  return !(now - entry.savedAt <= CACHE_MAX_AGE_MS);
}

/** Keys to delete: older than `maxAgeMs`, then the oldest until at most `maxEntries` remain. */
export function selectEvictions(
  index: CacheIndex,
  now: number,
  maxEntries = CACHE_MAX_ENTRIES,
  maxAgeMs = CACHE_MAX_AGE_MS,
): string[] {
  const entries = Object.entries(index).toSorted((a, b) => b[1] - a[1]); // newest first
  const doomed: string[] = [];
  let kept = 0;
  for (const [key, savedAt] of entries) {
    if (!(now - savedAt <= maxAgeMs) || kept >= maxEntries) doomed.push(key);
    else kept++;
  }
  return doomed;
}

export async function loadCache(
  key: string,
  storage: CacheStorage = local(),
): Promise<CacheEntry | null> {
  const stored = await storage.get(key);
  const entry = stored[key] as CacheEntry | undefined;
  if (!entry || !Array.isArray(entry.chunks) || !Array.isArray(entry.cues)) return null;
  // Expired entries are only deleted on the next save; never use them meanwhile.
  return isExpired(entry, Date.now()) ? null : entry;
}

/**
 * Saves one entry with its meta key in a single write, then evicts. If the write fails
 * (storage full: chrome.storage.local holds 10 MB, and a long translated video's entry is
 * a few hundred KB), evicts the oldest entries, one more each time and then doubling, until
 * it fits, so a full storage area recovers however few entries it holds.
 */
export async function saveCache(
  key: string,
  entry: CacheEntry,
  storage: CacheStorage = local(),
): Promise<void> {
  const items = { [key]: entry, [metaKeyOf(key)]: entry.savedAt };
  try {
    await storage.set(items);
  } catch {
    const others = (await listKeys(storage)).filter(
      (other) => other.startsWith(CACHE_PREFIX) && other !== key,
    ).length;
    for (let drop = 1; ; drop *= 2) {
      const keep = Math.max(0, Math.min(CACHE_MAX_ENTRIES - 1, others - drop));
      await evict(entry.savedAt, storage, keep, key);
      try {
        await storage.set(items);
        break;
      } catch (error) {
        if (keep === 0) throw error; // too big even alone
      }
    }
  }
  await evict(entry.savedAt, storage);
}

/**
 * Removes expired entries and the oldest beyond CACHE_MAX_ENTRIES, judged from the meta
 * keys (rebuilt first for entries that have none). Safe to run in several tabs at once:
 * it only ever removes whole entries with their meta keys.
 */
export async function evict(
  now: number,
  storage: CacheStorage = local(),
  maxEntries = CACHE_MAX_ENTRIES,
  /** An entry being saved: neither counted nor evicted. */
  except?: string,
): Promise<void> {
  const keys = await listKeys(storage);
  const metaKeys = keys.filter((key) => key.startsWith(CACHE_META_PREFIX));
  const withMeta = new Set(metaKeys.map(entryKeyOf));
  const missing = keys.filter((key) => key.startsWith(CACHE_PREFIX) && !withMeta.has(key));
  const index: CacheIndex = {};

  const metas = metaKeys.length ? await storage.get(metaKeys) : {};
  for (const metaKey of metaKeys) {
    const savedAt = metas[metaKey];
    index[entryKeyOf(metaKey)] = typeof savedAt === "number" ? savedAt : Number.NaN;
  }

  if (missing.length || keys.includes(LEGACY_INDEX_KEY)) {
    // Entries from before the meta keys (or a write that never finished): rebuild.
    const stored = await storage.get(missing);
    const rebuilt: Record<string, number> = {};
    for (const key of missing) {
      const savedAt = (stored[key] as Partial<CacheEntry> | undefined)?.savedAt;
      index[key] = typeof savedAt === "number" ? savedAt : Number.NaN;
      if (Number.isFinite(index[key])) rebuilt[metaKeyOf(key)] = index[key]!;
    }
    if (Object.keys(rebuilt).length) {
      try {
        await storage.set(rebuilt);
      } catch {
        // Storage full: evict below (judged from the entries' own savedAt) without them.
      }
    }
    if (keys.includes(LEGACY_INDEX_KEY)) await storage.remove(LEGACY_INDEX_KEY);
  }

  if (except) delete index[except];
  const candidates = selectEvictions(index, now, maxEntries);
  if (!candidates.length) return;
  // Another tab may have saved one of them meanwhile (a fresh savedAt): keep those.
  const current = await storage.get(candidates.map(metaKeyOf));
  const evicted = candidates.filter((key) => {
    const savedAt = current[metaKeyOf(key)];
    const was = index[key]!;
    // No meta key: a broken entry, or one whose rebuilt meta key could not be written.
    if (savedAt === undefined) return !Number.isFinite(was) || missing.includes(key);
    return savedAt === was;
  });
  if (evicted.length) await storage.remove(evicted.flatMap((key) => [key, metaKeyOf(key)]));
}
