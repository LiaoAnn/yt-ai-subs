// Groq quota and usage: what is left of today's free-tier budget, how much each video
// used, and whether the extension should slow down or stop translating. Pure logic, shared
// by the background (which records usage and enforces the levels) and the popup (which
// shows them).
//
// Groq's x-ratelimit-* headers report `requests` per day, but `tokens` per minute and
// `audio-seconds` for a shorter window, so the daily token and audio budgets are estimated
// from our own record of what was billed in the last 24 hours.

import type { Cost, Dimension, LimiterState, RequestKind } from "@/background/rate-limiter";

const HOUR = 60 * 60 * 1000;
const DAY_HOURS = 24;

/** Groq's free-tier daily limits (AGENTS.md). */
export const DAILY_LIMITS: Record<RequestKind, Partial<Record<Dimension, number>>> = {
  whisper: { requests: 2000, audioSeconds: 28_800 },
  chat: { requests: 1000, tokens: 200_000 },
};

/** Below this share of a daily budget, the extension slows down / pauses translation. */
export const LOW_SHARE = 0.1;

/** Per-video usage is kept for this many videos (the most recent ones). */
export const MAX_VIDEOS = 30;

export const USAGE_STORAGE_KEY = "groqUsage";
export const LIMITER_STORAGE_KEY = "rateLimiter";

type Totals = Record<Dimension, number>;

export interface VideoUsage {
  /** Last time this video used the API (ms). */
  at: number;
  whisper: Totals;
  chat: Totals;
}

export interface UsageLedger {
  /** Billed usage per hour (hour = floor(ms / 1 h)), last 24 hours. */
  hours: Record<RequestKind, { hour: number; cost: Totals }[]>;
  videos: Record<string, VideoUsage>;
}

const zero = (): Totals => ({ requests: 0, audioSeconds: 0, tokens: 0 });

export function emptyLedger(): UsageLedger {
  return { hours: { whisper: [], chat: [] }, videos: {} };
}

/** Accepts whatever was stored (older or malformed) and returns a usable ledger. */
export function parseLedger(stored: unknown): UsageLedger {
  const ledger = emptyLedger();
  if (typeof stored !== "object" || stored === null) return ledger;
  const value = stored as Partial<UsageLedger>;
  for (const kind of ["whisper", "chat"] as const) {
    const hours = value.hours?.[kind];
    if (Array.isArray(hours)) {
      ledger.hours[kind] = hours.filter(
        (bucket) => Number.isFinite(bucket?.hour) && typeof bucket.cost === "object",
      );
    }
  }
  if (typeof value.videos === "object" && value.videos !== null) ledger.videos = value.videos;
  return ledger;
}

function add(into: Totals, cost: Cost) {
  for (const dimension of Object.keys(into) as Dimension[]) {
    into[dimension] += cost[dimension] ?? 0;
  }
}

/** Records a billed request (in place), dropping buckets older than a day. */
export function recordUsage(
  ledger: UsageLedger,
  kind: RequestKind,
  videoId: string | null,
  cost: Cost,
  now: number,
): void {
  const hour = Math.floor(now / HOUR);
  const buckets = ledger.hours[kind].filter((bucket) => bucket.hour > hour - DAY_HOURS);
  let bucket = buckets.find((candidate) => candidate.hour === hour);
  if (!bucket) {
    bucket = { hour, cost: zero() };
    buckets.push(bucket);
  }
  add(bucket.cost, cost);
  ledger.hours[kind] = buckets;
  if (!videoId) return;
  const video = (ledger.videos[videoId] ??= { at: now, whisper: zero(), chat: zero() });
  video.at = now;
  add(video[kind], cost);
  const ids = Object.keys(ledger.videos);
  if (ids.length > MAX_VIDEOS) {
    const oldest = ids.toSorted((a, b) => ledger.videos[a]!.at - ledger.videos[b]!.at);
    for (const id of oldest.slice(0, ids.length - MAX_VIDEOS)) delete ledger.videos[id];
  }
}

/** What was billed in the last 24 hours (by whole hours). */
export function usedLastDay(ledger: UsageLedger, kind: RequestKind, now: number): Totals {
  const hour = Math.floor(now / HOUR);
  const total = zero();
  for (const bucket of ledger.hours[kind]) {
    if (bucket.hour > hour - DAY_HOURS && bucket.hour <= hour) add(total, bucket.cost);
  }
  return total;
}

export type QuotaLevel = "ok" | "low" | "out";

export interface DailyBudget {
  dimension: Dimension;
  limit: number;
  remaining: number;
  /** "groq": from Groq's headers; "estimate": daily limit minus our own 24 h record. */
  source: "groq" | "estimate";
  /** When Groq said the budget resets (ms), for "groq" budgets. */
  resetAt: number | null;
}

export interface KindQuota {
  level: QuotaLevel;
  daily: DailyBudget[];
}

export type QuotaLevels = Record<RequestKind, QuotaLevel>;

/** The level of one budget: "out" when nothing is left, "low" under LOW_SHARE. */
export function levelOf(budget: Pick<DailyBudget, "limit" | "remaining">): QuotaLevel {
  if (budget.remaining <= 0) return "out";
  return budget.remaining < budget.limit * LOW_SHARE ? "low" : "ok";
}

const LEVEL_ORDER: QuotaLevel[] = ["ok", "low", "out"];
const worst = (levels: QuotaLevel[]): QuotaLevel =>
  levels.reduce<QuotaLevel>(
    (a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a),
    "ok",
  );

/**
 * Today's budgets for one kind of request. Daily requests come from Groq's headers while
 * they are fresh; tokens and audio seconds are estimated. If Groq reports a higher daily
 * request limit than the free tier (a paid plan), the estimated limits scale with it.
 */
export function quotaFor(
  kind: RequestKind,
  limiter: LimiterState | undefined,
  ledger: UsageLedger,
  now: number,
): KindQuota {
  const used = usedLastDay(ledger, kind, now);
  const server = limiter?.server?.[kind]?.requests;
  const freeRequests = DAILY_LIMITS[kind].requests ?? 0;
  const scale = server?.limit && freeRequests ? Math.max(1, server.limit / freeRequests) : 1;
  const daily: DailyBudget[] = [];
  for (const [dimension, freeLimit] of Object.entries(DAILY_LIMITS[kind]) as [
    Dimension,
    number,
  ][]) {
    if (dimension === "requests" && server && server.resetAt > now) {
      daily.push({
        dimension,
        limit: server.limit ?? freeLimit,
        remaining: Math.max(0, server.remaining),
        source: "groq",
        resetAt: server.resetAt,
      });
      continue;
    }
    const limit = Math.round(freeLimit * scale);
    daily.push({
      dimension,
      limit,
      remaining: Math.max(0, limit - used[dimension]),
      source: "estimate",
      resetAt: null,
    });
  }
  return { level: worst(daily.map(levelOf)), daily };
}

export function quotaLevels(
  limiter: LimiterState | undefined,
  ledger: UsageLedger,
  now: number,
): QuotaLevels {
  return {
    whisper: quotaFor("whisper", limiter, ledger, now).level,
    chat: quotaFor("chat", limiter, ledger, now).level,
  };
}

/** Whether translation is paused to keep the rest of the day's budget (original only). */
export const translationPaused = (levels: QuotaLevels) => levels.chat !== "ok";

export const TRANSLATION_PAUSED_MESSAGE = "翻譯額度剩不到 10%，暫停翻譯，只顯示原文";
