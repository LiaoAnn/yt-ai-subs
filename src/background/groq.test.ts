import { describe, expect, it } from "vitest";
import { estimateChatTokens, numberLines, parseTranslatedLines } from "./groq";

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
