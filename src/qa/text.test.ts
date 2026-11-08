import { describe, expect, it } from "vitest";
import {
  bigramOverlap,
  cer,
  chrF,
  editDistance,
  isNonSpeech,
  normalizeForCer,
  speechText,
} from "./text";

describe("speechText", () => {
  it("drops caption cards, sound notes and speaker labels", () => {
    expect(speechText("[해맑게 저장하는 잠용이] 진짜요?")).toBe("진짜요?");
    expect(speechText("리원 / 안녕하세요")).toBe("안녕하세요");
    expect(speechText("（ナレーション）♪ そうですね～")).toBe("そうですね");
    expect(speechText("[인모] 뭐야\n(감격)")).toBe("뭐야");
  });

  it("keeps numbers with a slash", () => {
    expect(speechText("9/10 です")).toBe("9/10 です");
  });

  it("knows a line that is only a card", () => {
    expect(isNonSpeech("[音楽]")).toBe(true);
    expect(isNonSpeech("(박수)")).toBe(true);
    expect(isNonSpeech("はい")).toBe(false);
  });
});

describe("normalizeForCer", () => {
  it("removes punctuation and spaces and folds full-width forms", () => {
    expect(normalizeForCer("ＡＢＣ、です。 ﾃｽﾄ!")).toBe("abcですテスト");
  });
});

describe("cer", () => {
  it("counts edits per reference character", () => {
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    const r = cer("今日は晴れです。", "今日は雨です");
    expect(r.refChars).toBe(7);
    expect(r.edits).toBe(2); // 晴れ → 雨: one substitution, one deletion
    expect(r.cer).toBeCloseTo(2 / 7);
  });

  it("is 0 for the same text and 1 for nothing", () => {
    expect(cer("안녕하세요", "안녕 하세요!").cer).toBe(0);
    expect(cer("안녕하세요", "").cer).toBe(1);
  });
});

describe("chrF", () => {
  it("is 100 for the same text and lower for a worse translation", () => {
    expect(chrF("我們今天去看電影", "我們今天去看電影")).toBeCloseTo(100);
    const close = chrF("我們今天去看電影", "我們今天要去看電影");
    const far = chrF("我們今天去看電影", "明天他吃飯");
    expect(close).toBeGreaterThan(40); // one inserted character breaks every n-gram across it
    expect(far).toBeLessThan(10);
  });

  it("weights recall twice as much as precision (beta = 2)", () => {
    // n = 1–2: precision 1, recall (2/4 + 1/3) / 2 = 5/12; F2 = 5·P·R / (4·P + R)
    expect(chrF("abcd", "ab", 2)).toBeCloseTo((100 * 5 * (5 / 12)) / (4 + 5 / 12), 6);
    expect(chrF("ab", "abcd", 2)).toBeCloseTo((100 * 5 * (5 / 12)) / (4 * (5 / 12) + 1), 6);
  });

  it("does not care where lines were split", () => {
    expect(chrF("我們今天，去看電影。", "我們今天去看\n電影")).toBeCloseTo(100);
  });
});

describe("bigramOverlap", () => {
  it("is the share of the first text's pairs found in the second", () => {
    expect(bigramOverlap("こんにちは", "えっとこんにちは皆さん")).toBe(1);
    expect(bigramOverlap("ありがとう", "こんにちは")).toBe(0);
  });
});
