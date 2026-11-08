import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import { emptyLedger, quotaFor, recordUsage } from "@/shared/quota";
import {
  estimateChatTokens,
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
    expect(estimateChatTokens(1000, 10)).toBeGreaterThan(estimateChatTokens(500, 10));
    expect(estimateChatTokens(1000, 20)).toBeGreaterThan(estimateChatTokens(1000, 10));
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
    const prompt = buildWhisperPrompt(
      { videoId: "a", title: "Some Show", channel: "Chan", description: "", keywords: [] },
      "word ".repeat(400),
      "en",
    );
    expect(prompt.startsWith("Some Show. Chan.")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(WHISPER_PROMPT_CHARS);
  });
});
