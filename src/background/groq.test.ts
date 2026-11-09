import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import { emptyLedger, quotaFor, recordUsage } from "@/shared/quota";
import {
  captionNotesRule,
  GroqError,
  estimateChatTokens,
  failedReply,
  isRetryable,
  numberLines,
  parseTranslatedLines,
  transcribe,
  translate,
  translationUserMessage,
} from "./groq";
import { RateLimiter, type Cost } from "./rate-limiter";

describe("parseTranslatedLines", () => {
  it("maps numbered keys back to lines, leaving merged or missing lines undefined", () => {
    expect(parseTranslatedLines('{"1": "你好", "2": "再見"}', 2)).toEqual(["你好", "再見"]);
    expect(parseTranslatedLines('{"1": "合併的整句", "3": "第三"}', 3)).toEqual([
      "合併的整句",
      undefined,
      "第三",
    ]);
  });

  it("also reads a plain array, wrapped in other text", () => {
    expect(parseTranslatedLines('Sure:\n```json\n{"t": ["a", "b"]}\n```', 2)).toEqual(["a", "b"]);
    expect(parseTranslatedLines('{"lines": ["a"]}', 2)).toEqual(["a", undefined]);
  });

  it("returns null for unusable replies", () => {
    expect(parseTranslatedLines("no json", 1)).toBeNull();
    expect(parseTranslatedLines('{"x": "unrelated"}', 1)).toBeNull();
    expect(parseTranslatedLines("{broken", 1)).toBeNull();
  });
});

describe("numberLines", () => {
  it("numbers from 1", () => {
    expect(numberLines(["a", "b"])).toEqual({ "1": "a", "2": "b" });
  });
});

describe("estimateChatTokens", () => {
  it("grows with the prompt and the number of lines", () => {
    const ja = "あ".repeat(1000);
    expect(estimateChatTokens(ja, 10)).toBeGreaterThan(estimateChatTokens(ja.slice(500), 10));
    expect(estimateChatTokens(ja, 20)).toBeGreaterThan(estimateChatTokens(ja, 10));
  });

  it("counts English at about four characters a token and CJK at one", () => {
    expect(estimateChatTokens("a".repeat(2400), 0)).toBe(600 + 400);
    expect(estimateChatTokens("漢".repeat(600), 0)).toBe(600 + 400);
    // A chunk of 12 dense lines: the English system prompt no longer dominates.
    const prompt = "x".repeat(2300) + "日本語の台詞です".repeat(40);
    expect(estimateChatTokens(prompt, 12)).toBeLessThan(2000);
  });
});

// A fake Groq: fetch is mocked, nothing leaves the test.
describe("billing with a mocked Groq", () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings = { ...DEFAULT_SETTINGS, groqApiKey: "gsk_fake_not_a_real_key" };
  const signal = new AbortController().signal;

  it("bills a short transcription as 10 s and keeps Groq's daily request budget", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { text: "", language: "ja", segments: [], words: [] },
        {
          headers: {
            "x-ratelimit-limit-requests": "2000",
            "x-ratelimit-remaining-requests": "1500",
            "x-ratelimit-reset-requests": "3h",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const limiter = new RateLimiter();
    const billed: Cost[] = [];
    await transcribe(
      limiter,
      settings,
      new Uint8Array(8),
      4,
      "",
      signal,
      () => {},
      (cost) => billed.push(cost),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(billed).toEqual([{ requests: 1, audioSeconds: 10 }]);
    const ledger = emptyLedger();
    recordUsage(ledger, "whisper", "vid", billed[0]!, Date.now());
    const quota = quotaFor("whisper", limiter.snapshot(), ledger, Date.now());
    expect(quota.daily).toMatchObject([
      { dimension: "requests", limit: 2000, remaining: 1500, source: "groq" },
      { dimension: "audioSeconds", limit: 28_800, remaining: 28_790, source: "estimate" },
    ]);
  });

  it("bills a translation by its real token usage, and nothing for a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: '{"1": "你好"}' } }],
          usage: { total_tokens: 321 },
        }),
      ),
    );
    const billed: Cost[] = [];
    const onBilled = (cost: Cost) => billed.push(cost);
    const result = await translate(
      new RateLimiter(),
      settings,
      ["こんにちは"],
      "",
      signal,
      () => {},
      onBilled,
    );
    expect(result.lines).toEqual(["你好"]);
    expect(billed).toEqual([{ requests: 1, tokens: 321 }]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: {} }, { status: 400 })),
    );
    await expect(
      translate(new RateLimiter(), settings, ["x"], "", signal, () => {}, onBilled),
    ).rejects.toThrow("翻譯失敗 400");
    expect(billed).toHaveLength(1);
  });

  it("reports the lines a reply left out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: '{"1": "一", "3": "三"}' } }],
          usage: { total_tokens: 100 },
        }),
      ),
    );
    const result = await translate(
      new RateLimiter(),
      settings,
      ["a", "b", "c"],
      "",
      signal,
      () => {},
    );
    expect(result.lines).toEqual(["一", "b", "三"]);
    expect(result.missing).toEqual([1]);
  });

  it("frees a failed request's token estimate, so the next one need not wait for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "boom" } }, { status: 500 })),
    );
    const limiter = new RateLimiter();
    const error = await translate(limiter, settings, ["x"], "", signal, () => {}).catch(
      (e: unknown) => e,
    );
    expect(isRetryable(error)).toBe(true);
    const entry = limiter.snapshot().entries.chat[0]!;
    expect(entry.cost).toEqual({ requests: 1, tokens: 0 });
  });
});

describe("failed translations through translate()", () => {
  afterEach(() => vi.unstubAllGlobals());
  const settings = { ...DEFAULT_SETTINGS, groqApiKey: "gsk_fake_not_a_real_key" };
  const signal = new AbortController().signal;
  const reply = () =>
    translate(new RateLimiter(), settings, ["x"], "", signal, () => {}).then(
      () => ({ ok: true }),
      (e: unknown) => failedReply(e, false),
    );

  it("marks Groq's json_validate_failed 400 as retryable, not other 400s or a bad key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "Failed to generate JSON", code: "json_validate_failed" } },
          { status: 400 },
        ),
      ),
    );
    expect(await reply()).toMatchObject({ ok: false, retryable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "bad" } }, { status: 400 })),
    );
    expect(await reply()).not.toHaveProperty("retryable");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })),
    );
    expect(await reply()).not.toHaveProperty("retryable");
  });

  it("marks an unreadable reply as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ choices: [{ message: { content: '{"1": ' } }] })),
    );
    expect(await reply()).toMatchObject({
      ok: false,
      error: "翻譯格式看不懂",
      retryable: true,
    });
  });

  it("never marks a cancelled request as retryable", () => {
    expect(failedReply(new GroqError("x", 503), true)).toEqual({
      ok: false,
      error: "cancelled",
      aborted: true,
    });
  });

  it("keeps the request but frees the tokens of a 429 retried by the limiter", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? Response.json({}, { status: 429, headers: { "retry-after": "0.01" } })
          : Response.json({
              choices: [{ message: { content: '{"1": "好"}' } }],
              usage: { total_tokens: 300 },
            }),
      ),
    );
    const limiter = new RateLimiter();
    await translate(limiter, settings, ["x"], "", signal, () => {});
    expect(limiter.snapshot().entries.chat.map((entry) => entry.cost)).toEqual([
      { requests: 1, tokens: 0 },
      { requests: 1, tokens: 300 },
    ]);
  });
});

describe("isRetryable", () => {
  it("retries Groq's failures and unreadable JSON, not a bad key or request", () => {
    expect(isRetryable(new GroqError("翻譯格式看不懂"))).toBe(true);
    expect(isRetryable(new GroqError("x", 503))).toBe(true);
    expect(isRetryable(new GroqError("x", 429))).toBe(true);
    expect(isRetryable(new GroqError("x", 400, "json_validate_failed"))).toBe(true);
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryable(new GroqError("x", 401, "invalid_api_key"))).toBe(false);
    expect(isRetryable(new GroqError("x", 400))).toBe(false);
    expect(isRetryable(new Error("請先在擴充功能設定填 Groq API key"))).toBe(false);
  });
});

describe("translationUserMessage", () => {
  it("gives the video, the glossary, the context and the numbered lines, in that order", () => {
    const text = translationUserMessage(["유재석 형"], "앞 → 前", {
      video: { title: "지석진의\n핑계", channel: "뜬뜬" },
      glossary: [["유재석", "劉在錫"]],
    });
    expect(text).toBe(
      'Video: "지석진의 핑계", channel 뜬뜬\n\n' +
        "Glossary (renderings already used in this video; use them again):\n유재석 → 劉在錫\n\n" +
        "Previous lines (original → translation), for context only:\n앞 → 前\n\n" +
        'Lines to translate (1):\n{"1":"유재석 형"}',
    );
  });

  it("leaves out what is missing", () => {
    expect(translationUserMessage(["a"], "")).toBe('Lines to translate (1):\n{"1":"a"}');
  });
});

describe("Whisper prompt cap", () => {
  it("keeps everything buildWhisperPrompt returns, even with long Latin captions", async () => {
    const { buildWhisperPrompt } = await import("@/shared/video-context");
    const { WHISPER_PROMPT_CHARS } = await import("./groq");
    const prompt = buildWhisperPrompt("word ".repeat(400) + "end");
    expect(prompt.endsWith("word end")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(WHISPER_PROMPT_CHARS);
  });
});

describe("captionNotesRule", () => {
  it("is added only for lines with caption cards or speaker labels", () => {
    expect(captionNotesRule(["今日はいい天気ですね", "そうですね"])).toBe("");
    expect(captionNotesRule(["[拍手]"])).toContain("brackets");
    expect(captionNotesRule(["(감격)"])).toContain("brackets");
    expect(captionNotesRule(["리원 / 안녕하세요"])).toContain("speaker label");
    expect(captionNotesRule(["太郎：おはよう"])).toContain("speaker label");
  });
});
