// Client-side rate limiter for every Groq request. Keeps a sliding-window log per request
// kind and also honours what Groq reports: x-ratelimit-* headers and 429 retry-after.
// Pure logic with an injectable clock; the background wires it to fetch and storage.

export type RequestKind = "whisper" | "chat";
export type Dimension = "requests" | "audioSeconds" | "tokens";
export type Cost = Partial<Record<Dimension, number>>;

export interface WindowLimit {
  dimension: Dimension;
  max: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Our own ceilings, a little under Groq's free tier (AGENTS.md): Whisper 20 req/min and
 * 7,200 audio s/hour; gpt-oss 30 req/min and 8K tokens/min.
 */
export const GROQ_LIMITS: Record<RequestKind, WindowLimit[]> = {
  whisper: [
    { dimension: "requests", max: 18, windowMs: MINUTE },
    { dimension: "audioSeconds", max: 7000, windowMs: HOUR },
  ],
  chat: [
    { dimension: "requests", max: 28, windowMs: MINUTE },
    { dimension: "tokens", max: 7500, windowMs: MINUTE },
  ],
};

/** Groq bills every transcription as at least 10 seconds of audio. */
export const MIN_BILLED_AUDIO_SECONDS = 10;

export interface Entry {
  id: number;
  at: number;
  cost: Cost;
}

export interface ServerBudget {
  remaining: number;
  resetAt: number;
  /** x-ratelimit-limit-*, when Groq sent it. */
  limit?: number;
}

export interface LimiterState {
  nextId: number;
  entries: Record<RequestKind, Entry[]>;
  blockedUntil: Record<RequestKind, number>;
  server: Record<RequestKind, Partial<Record<Dimension, ServerBudget>>>;
}

/** Minimal Headers interface, so tests can pass a Map-like object. */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Parses Groq's reset durations such as "2m59.56s", "7.66s", "1h0m0s" or "120ms" into ms.
 * Returns null for anything else.
 */
export function parseResetDuration(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * (unit === "h" ? HOUR : unit === "m" ? MINUTE : unit === "s" ? 1000 : 1);
    consumed += match[0].length;
  }
  return consumed === text.length && consumed > 0 ? total : null;
}

/** Maps a header suffix (x-ratelimit-remaining-<suffix>) to the cost dimension it limits. */
function dimensionOf(suffix: string): Dimension | null {
  if (suffix === "requests") return "requests";
  if (suffix === "tokens") return "tokens";
  if (suffix.includes("audio")) return "audioSeconds";
  return null;
}

const HEADER_SUFFIXES = ["requests", "tokens", "audio-seconds", "audio_seconds"] as const;

export class RateLimiter {
  private state: LimiterState;

  constructor(
    private readonly limits: Record<RequestKind, WindowLimit[]> = GROQ_LIMITS,
    state?: LimiterState,
  ) {
    this.state = state ?? {
      nextId: 1,
      entries: { whisper: [], chat: [] },
      blockedUntil: { whisper: 0, chat: 0 },
      server: { whisper: {}, chat: {} },
    };
  }

  /** A JSON-safe copy of the state, to persist across service worker restarts. */
  snapshot(): LimiterState {
    return structuredClone(this.state);
  }

  /** Milliseconds to wait before a request of `cost` fits every limit; 0 means now. */
  delayFor(kind: RequestKind, cost: Cost, now: number): number {
    this.prune(now);
    let wait = Math.max(0, this.state.blockedUntil[kind] - now);
    const entries = this.state.entries[kind];
    for (const limit of this.limits[kind]) {
      // A single request bigger than the whole budget still runs, once the window is empty.
      const needed = Math.min(cost[limit.dimension] ?? 0, limit.max);
      if (needed <= 0) continue;
      const inWindow = entries.filter((entry) => entry.at > now - limit.windowMs);
      let used = inWindow.reduce((sum, entry) => sum + (entry.cost[limit.dimension] ?? 0), 0);
      // Entries are kept in time order; drop the oldest until the request fits.
      for (const entry of inWindow) {
        if (used + needed <= limit.max) break;
        used -= entry.cost[limit.dimension] ?? 0;
        wait = Math.max(wait, entry.at + limit.windowMs - now);
      }
    }
    for (const [dimension, budget] of Object.entries(this.state.server[kind])) {
      const needed = cost[dimension as Dimension] ?? 0;
      if (needed > 0 && budget.resetAt > now && budget.remaining < needed) {
        wait = Math.max(wait, budget.resetAt - now);
      }
    }
    return Math.ceil(wait);
  }

  /** Records a request that is about to be sent; returns its entry id. */
  record(kind: RequestKind, cost: Cost, now: number): number {
    const id = this.state.nextId++;
    this.state.entries[kind].push({ id, at: now, cost: { ...cost } });
    for (const [dimension, budget] of Object.entries(this.state.server[kind])) {
      budget.remaining -= cost[dimension as Dimension] ?? 0;
    }
    return id;
  }

  /** Replaces an entry's estimated cost with the real one (e.g. usage.total_tokens). */
  adjust(kind: RequestKind, id: number, cost: Cost): void {
    const entry = this.state.entries[kind].find((candidate) => candidate.id === id);
    if (entry) entry.cost = { ...entry.cost, ...cost };
  }

  /** Reads x-ratelimit-remaining-* / x-ratelimit-reset-* from a Groq response. */
  noteHeaders(kind: RequestKind, headers: HeaderSource, now: number): void {
    for (const suffix of HEADER_SUFFIXES) {
      const dimension = dimensionOf(suffix);
      const remainingText = headers.get(`x-ratelimit-remaining-${suffix}`);
      if (!dimension || remainingText === null) continue;
      const remaining = Number(remainingText);
      const reset = parseResetDuration(headers.get(`x-ratelimit-reset-${suffix}`));
      if (!Number.isFinite(remaining) || reset === null) continue;
      const limit = Number(headers.get(`x-ratelimit-limit-${suffix}`) ?? Number.NaN);
      this.state.server[kind][dimension] = {
        remaining,
        resetAt: now + reset,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      };
    }
  }

  /** A 429: block this kind for retry-after seconds (or `fallbackMs` if the header is missing). */
  noteTooManyRequests(kind: RequestKind, headers: HeaderSource, now: number, fallbackMs = 10_000) {
    const retryAfter = parseResetDuration(headers.get("retry-after"));
    const until = now + (retryAfter ?? fallbackMs);
    this.state.blockedUntil[kind] = Math.max(this.state.blockedUntil[kind], until);
    return until - now;
  }

  private prune(now: number): void {
    for (const kind of Object.keys(this.state.entries) as RequestKind[]) {
      const longest = Math.max(...this.limits[kind].map((limit) => limit.windowMs));
      this.state.entries[kind] = this.state.entries[kind].filter(
        (entry) => entry.at > now - longest,
      );
    }
  }
}

/** Waits `ms`, rejecting with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Waits until `cost` fits, then records it. Re-checks after every wait, since other
 * requests (or new server headers) may have changed the budget meanwhile.
 */
export async function acquire(
  limiter: RateLimiter,
  kind: RequestKind,
  cost: Cost,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<{ id: number; waitedMs: number }> {
  const started = now();
  for (;;) {
    signal?.throwIfAborted();
    const delay = limiter.delayFor(kind, cost, now());
    if (delay <= 0) return { id: limiter.record(kind, cost, now()), waitedMs: now() - started };
    await sleep(delay, signal);
  }
}
