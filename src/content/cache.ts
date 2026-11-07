// Finished captions per video, in chrome.storage.local, so re-watching costs nothing.
// An index keeps every entry's last write time; old entries and the oldest beyond a
// fixed count are removed whenever something is saved.

import type { Cue } from "@/shared/captions";
import type { Settings } from "@/shared/settings";

export interface CachedChunk {
  start: number;
  end: number;
}

export interface CacheEntry {
  chunks: CachedChunk[];
  cues: Cue[];
  savedAt: number;
}

/** Storage key -> savedAt (ms). */
export type CacheIndex = Record<string, number>;

export const CACHE_PREFIX = "cache:";
const INDEX_KEY = "cacheIndex";
export const CACHE_MAX_ENTRIES = 50;
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One cache entry per video and per setting that changes the captions. */
export function cacheKey(videoId: string, settings: Settings): string {
  const translation = settings.translate
    ? `${settings.translationModel}:${settings.targetLanguage}`
    : "none";
  return `${CACHE_PREFIX}${videoId}:${settings.whisperModel}:${settings.sourceLanguage}:${translation}`;
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
  const evict: string[] = [];
  let kept = 0;
  for (const [key, savedAt] of entries) {
    if (now - savedAt > maxAgeMs || kept >= maxEntries) evict.push(key);
    else kept++;
  }
  return evict;
}

export async function loadCache(key: string): Promise<CacheEntry | null> {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key] as CacheEntry | undefined;
  if (!entry || !Array.isArray(entry.chunks) || !Array.isArray(entry.cues)) return null;
  // Expired entries are only deleted on the next save; never use them meanwhile.
  return isExpired(entry, Date.now()) ? null : entry;
}

export async function saveCache(key: string, entry: CacheEntry): Promise<void> {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  const index: CacheIndex = {
    ...(stored[INDEX_KEY] as CacheIndex | undefined),
    [key]: entry.savedAt,
  };
  const evict = selectEvictions(index, entry.savedAt);
  for (const old of evict) delete index[old];
  if (evict.length) await chrome.storage.local.remove(evict);
  await chrome.storage.local.set({ [key]: entry, [INDEX_KEY]: index });
}
