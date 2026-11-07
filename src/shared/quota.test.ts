import { describe, expect, it } from "vitest";
import { RateLimiter, type HeaderSource } from "@/background/rate-limiter";
import {
  MAX_VIDEOS,
  emptyLedger,
  parseLedger,
  quotaFor,
  quotaLevels,
  recordUsage,
  translationPaused,
  usedLastDay,
} from "./quota";

const HOUR = 3_600_000;
const headers = (values: Record<string, string>): HeaderSource => ({
  get: (name) => values[name] ?? null,
});

describe("usage ledger", () => {
  it("sums the last 24 hours and forgets older usage", () => {
    const ledger = emptyLedger();
    const now = 100 * HOUR;
    recordUsage(ledger, "whisper", "a", { requests: 1, audioSeconds: 30 }, now - 25 * HOUR);
    recordUsage(ledger, "whisper", "a", { requests: 1, audioSeconds: 10 }, now - 2 * HOUR);
    recordUsage(ledger, "whisper", "b", { requests: 1, audioSeconds: 20 }, now);
    recordUsage(ledger, "chat", "b", { requests: 1, tokens: 900 }, now);
    expect(usedLastDay(ledger, "whisper", now)).toEqual({
      requests: 2,
      audioSeconds: 30,
      tokens: 0,
    });
    expect(ledger.hours.whisper).toHaveLength(2); // the 25 h old bucket was dropped
    expect(ledger.videos.a!.whisper).toEqual({ requests: 2, audioSeconds: 40, tokens: 0 });
    expect(ledger.videos.b!.chat.tokens).toBe(900);
  });

  it("keeps only the most recent videos", () => {
    const ledger = emptyLedger();
    for (let i = 0; i < MAX_VIDEOS + 5; i++) {
      recordUsage(ledger, "chat", `v${i}`, { requests: 1 }, i * 1000);
    }
    expect(Object.keys(ledger.videos)).toHaveLength(MAX_VIDEOS);
    expect(ledger.videos.v0).toBeUndefined();
    expect(ledger.videos[`v${MAX_VIDEOS + 4}`]).toBeDefined();
  });

  it("parses missing or malformed storage as empty", () => {
    expect(parseLedger(undefined)).toEqual(emptyLedger());
    expect(parseLedger({ hours: { whisper: [{ hour: "x" }] } }).hours.whisper).toEqual([]);
  });
});

describe("quotaFor", () => {
  it("uses Groq's daily request budget while fresh, and estimates tokens", () => {
    const limiter = new RateLimiter();
    limiter.noteHeaders(
      "chat",
      headers({
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": "640",
        "x-ratelimit-reset-requests": "2h0m0s",
        "x-ratelimit-remaining-tokens": "7000",
        "x-ratelimit-reset-tokens": "4s",
      }),
      0,
    );
    const ledger = emptyLedger();
    recordUsage(ledger, "chat", "v", { requests: 1, tokens: 50_000 }, 0);
    const quota = quotaFor("chat", limiter.snapshot(), ledger, 1000);
    expect(quota.daily).toEqual([
      { dimension: "requests", limit: 1000, remaining: 640, source: "groq", resetAt: 2 * HOUR },
      {
        dimension: "tokens",
        limit: 200_000,
        remaining: 150_000,
        source: "estimate",
        resetAt: null,
      },
    ]);
    expect(quota.level).toBe("ok");
    // After the reported reset, the requests fall back to our own estimate.
    expect(quotaFor("chat", limiter.snapshot(), ledger, 3 * HOUR).daily[0]).toMatchObject({
      source: "estimate",
      remaining: 999,
    });
  });

  it("goes low under 10% of any daily budget, and out at zero", () => {
    const ledger = emptyLedger();
    recordUsage(ledger, "chat", null, { requests: 1, tokens: 181_000 }, 0);
    expect(quotaFor("chat", undefined, ledger, 0).level).toBe("low");
    recordUsage(ledger, "chat", null, { requests: 1, tokens: 19_000 }, 0);
    expect(quotaFor("chat", undefined, ledger, 0).level).toBe("out");
    expect(quotaFor("whisper", undefined, ledger, 0).level).toBe("ok");
    const levels = quotaLevels(undefined, ledger, 0);
    expect(levels).toEqual({ whisper: "ok", chat: "out" });
    expect(translationPaused(levels)).toBe(true);
    expect(translationPaused({ whisper: "low", chat: "ok" })).toBe(false);
  });

  it("goes low when Groq reports few daily requests left", () => {
    const limiter = new RateLimiter();
    limiter.noteHeaders(
      "whisper",
      headers({
        "x-ratelimit-limit-requests": "2000",
        "x-ratelimit-remaining-requests": "150",
        "x-ratelimit-reset-requests": "1h",
      }),
      0,
    );
    expect(quotaFor("whisper", limiter.snapshot(), emptyLedger(), 0).level).toBe("low");
  });

  it("scales the estimated limits on a plan with a higher daily request limit", () => {
    const limiter = new RateLimiter();
    limiter.noteHeaders(
      "chat",
      headers({
        "x-ratelimit-limit-requests": "10000",
        "x-ratelimit-remaining-requests": "9990",
        "x-ratelimit-reset-requests": "1m",
      }),
      0,
    );
    const ledger = emptyLedger();
    recordUsage(ledger, "chat", null, { requests: 1, tokens: 190_000 }, 0);
    const quota = quotaFor("chat", limiter.snapshot(), ledger, 0);
    expect(quota.daily[1]).toMatchObject({ limit: 2_000_000, remaining: 1_810_000 });
    expect(quota.level).toBe("ok");
  });
});
