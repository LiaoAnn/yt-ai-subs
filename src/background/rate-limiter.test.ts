import { describe, expect, it } from "vitest";
import { RateLimiter, acquire, parseResetDuration, type HeaderSource } from "./rate-limiter";

const headers = (values: Record<string, string>): HeaderSource => ({
  get: (name) => values[name] ?? null,
});

describe("parseResetDuration", () => {
  it("parses Groq's duration strings", () => {
    expect(parseResetDuration("7.66s")).toBeCloseTo(7660);
    expect(parseResetDuration("2m59.56s")).toBeCloseTo(179_560);
    expect(parseResetDuration("1h0m0s")).toBe(3_600_000);
    expect(parseResetDuration("120ms")).toBe(120);
    expect(parseResetDuration("12")).toBe(12_000);
    expect(parseResetDuration("soon")).toBeNull();
    expect(parseResetDuration(null)).toBeNull();
  });
});

describe("RateLimiter windows", () => {
  it("allows 18 Whisper requests per minute, then waits for the oldest to expire", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 18; i++) {
      expect(limiter.delayFor("whisper", { requests: 1, audioSeconds: 10 }, i * 1000)).toBe(0);
      limiter.record("whisper", { requests: 1, audioSeconds: 10 }, i * 1000);
    }
    expect(limiter.delayFor("whisper", { requests: 1, audioSeconds: 10 }, 18_000)).toBe(42_000);
    expect(limiter.delayFor("whisper", { requests: 1, audioSeconds: 10 }, 60_001)).toBe(0);
  });

  it("caps Whisper audio at 7,000 seconds per hour", () => {
    const limiter = new RateLimiter();
    // 233 chunks of 30 s = 6,990 s, spread out so the per-minute limit never binds.
    for (let i = 0; i < 233; i++)
      limiter.record("whisper", { requests: 1, audioSeconds: 30 }, i * 10_000);
    const now = 233 * 10_000;
    expect(limiter.delayFor("whisper", { requests: 1, audioSeconds: 10 }, now)).toBe(0);
    // 30 more seconds would exceed: wait until the first chunk leaves the hour window.
    expect(limiter.delayFor("whisper", { requests: 1, audioSeconds: 30 }, now)).toBe(
      3_600_000 - now,
    );
  });

  it("caps chat tokens at 7,500 per minute, using corrected usage", () => {
    const limiter = new RateLimiter();
    const id = limiter.record("chat", { requests: 1, tokens: 7000 }, 0);
    expect(limiter.delayFor("chat", { requests: 1, tokens: 1000 }, 1000)).toBe(59_000);
    limiter.adjust("chat", id, { tokens: 1200 }); // the real usage was smaller
    expect(limiter.delayFor("chat", { requests: 1, tokens: 1000 }, 1000)).toBe(0);
  });

  it("lets a request larger than the whole budget through once the window is empty", () => {
    const limiter = new RateLimiter();
    expect(limiter.delayFor("chat", { requests: 1, tokens: 9000 }, 0)).toBe(0);
    limiter.record("chat", { requests: 1, tokens: 9000 }, 0);
    expect(limiter.delayFor("chat", { requests: 1, tokens: 9000 }, 1000)).toBe(59_000);
  });

  it("keeps kinds independent", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 18; i++) limiter.record("whisper", { requests: 1 }, 0);
    expect(limiter.delayFor("chat", { requests: 1, tokens: 100 }, 0)).toBe(0);
  });
});

describe("RateLimiter server feedback", () => {
  it("waits for the reset when Groq reports too few remaining tokens", () => {
    const limiter = new RateLimiter();
    limiter.noteHeaders(
      "chat",
      headers({
        "x-ratelimit-remaining-tokens": "300",
        "x-ratelimit-reset-tokens": "7.5s",
        "x-ratelimit-remaining-requests": "990",
        "x-ratelimit-reset-requests": "1m26s",
      }),
      0,
    );
    expect(limiter.delayFor("chat", { requests: 1, tokens: 200 }, 0)).toBe(0);
    expect(limiter.delayFor("chat", { requests: 1, tokens: 500 }, 0)).toBe(7500);
    expect(limiter.delayFor("chat", { requests: 1, tokens: 500 }, 8000)).toBe(0);
  });

  it("counts requests sent after the headers against the reported budget", () => {
    const limiter = new RateLimiter();
    limiter.noteHeaders(
      "whisper",
      headers({ "x-ratelimit-remaining-requests": "1", "x-ratelimit-reset-requests": "30s" }),
      0,
    );
    limiter.record("whisper", { requests: 1 }, 0);
    expect(limiter.delayFor("whisper", { requests: 1 }, 0)).toBe(30_000);
  });

  it("blocks a kind for retry-after after a 429", () => {
    const limiter = new RateLimiter();
    expect(limiter.noteTooManyRequests("whisper", headers({ "retry-after": "12" }), 0)).toBe(
      12_000,
    );
    expect(limiter.delayFor("whisper", { requests: 1 }, 1000)).toBe(11_000);
    expect(limiter.delayFor("chat", { requests: 1 }, 1000)).toBe(0);
    expect(limiter.noteTooManyRequests("chat", headers({}), 0, 5000)).toBe(5000);
  });

  it("survives a snapshot round trip", () => {
    const limiter = new RateLimiter();
    limiter.record("chat", { requests: 1, tokens: 7400 }, 0);
    const restored = new RateLimiter(undefined, JSON.parse(JSON.stringify(limiter.snapshot())));
    expect(restored.delayFor("chat", { requests: 1, tokens: 200 }, 1000)).toBe(59_000);
  });
});

describe("acquire", () => {
  it("waits for the limiter and then records the request", async () => {
    const limiter = new RateLimiter({
      whisper: [{ dimension: "requests", max: 1, windowMs: 30 }],
      chat: [],
    });
    limiter.record("whisper", { requests: 1 }, Date.now());
    const slot = await acquire(limiter, "whisper", { requests: 1 });
    expect(slot.waitedMs).toBeGreaterThanOrEqual(25);
    // The new request now fills the window.
    expect(limiter.delayFor("whisper", { requests: 1 }, Date.now())).toBeGreaterThan(0);
  });

  it("rejects when aborted while waiting", async () => {
    const limiter = new RateLimiter({
      whisper: [{ dimension: "requests", max: 1, windowMs: 60_000 }],
      chat: [],
    });
    limiter.record("whisper", { requests: 1 }, Date.now());
    const controller = new AbortController();
    const pending = acquire(limiter, "whisper", { requests: 1 }, controller.signal);
    controller.abort(new Error("seeked"));
    await expect(pending).rejects.toThrow("seeked");
  });
});
