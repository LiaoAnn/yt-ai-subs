import { describe, expect, it } from "vitest";
import {
  groupWords,
  dropRepeatedTails,
  isHallucination,
  joinWord,
  mergeBrokenSegments,
  padLines,
  whisperToCues,
} from "./segmentation";

describe("joinWord", () => {
  it("joins CJK without spaces and Latin with spaces", () => {
    expect(joinWord("今日は", "いい")).toBe("今日はいい");
    expect(joinWord("hello", "world")).toBe("hello world");
    expect(joinWord("hello", ",")).toBe("hello,");
    expect(joinWord("안녕하세요", " 여러분")).toBe("안녕하세요 여러분");
    // Groq's Korean words come without the leading space; Korean still needs it.
    expect(joinWord("재발방지와", "가해자")).toBe("재발방지와 가해자");
    expect(joinWord("재발방지와", ",")).toBe("재발방지와,");
    expect(joinWord("", " first")).toBe("first");
    expect(joinWord("magnitude 6.", "9")).toBe("magnitude 6.9");
  });
});

describe("groupWords", () => {
  it("breaks at sentence ends and long pauses", () => {
    const lines = groupWords([
      { text: "こんにちは。", start: 0, end: 1 },
      { text: "今日は", start: 1.1, end: 1.5 },
      { text: "晴れ", start: 1.5, end: 2 },
      { text: "です", start: 3, end: 3.4 },
    ]);
    expect(lines.map((line) => line.original)).toEqual(["こんにちは。", "今日は晴れ", "です"]);
    expect(lines[1]).toMatchObject({ start: 1.1, end: 2 });
  });

  it("breaks CJK lines that get too long", () => {
    const words = Array.from({ length: 30 }, (_, i) => ({
      text: "あ",
      start: i * 0.1,
      end: i * 0.1 + 0.1,
    }));
    const lines = groupWords(words);
    expect(lines.length).toBe(2);
    expect([...lines[0]!.original].length).toBe(24);
  });
});

describe("groupWords punctuation and numbers", () => {
  it("does not break inside a decimal number", () => {
    const lines = groupWords([
      { text: "規模は6.", start: 0, end: 1 },
      { text: "9です。", start: 1, end: 1.5 },
    ]);
    expect(lines.map((line) => line.original)).toEqual(["規模は6.9です。"]);
  });

  it("keeps punctuation after a sentence break on the previous line", () => {
    const lines = groupWords([
      { text: "はい。", start: 0, end: 0.5 },
      { text: "、", start: 0.5, end: 0.6 },
      { text: "次", start: 0.7, end: 1 },
    ]);
    expect(lines.map((line) => line.original)).toEqual(["はい。、", "次"]);
  });
});

describe("mergeBrokenSegments", () => {
  it("joins segments split inside a number or before a comma", () => {
    const merged = mergeBrokenSegments([
      { start: 0, end: 2, text: "実際の大きさは6." },
      { start: 2, end: 3, text: "9です。" },
      { start: 3, end: 5, text: "そのため" },
      { start: 5, end: 7, text: "、誰もが" },
      { start: 7, end: 9, text: "次の文" },
    ]);
    expect(merged.map((s) => [s.start, s.end, s.text])).toEqual([
      [0, 3, "実際の大きさは6.9です。"],
      [3, 7, "そのため、誰もが"],
      [7, 9, "次の文"],
    ]);
  });
});

describe("dropRepeatedTails", () => {
  it("drops a line that echoes the end of the previous one", () => {
    const out = dropRepeatedTails([
      { start: 55.7, end: 56.7, original: "이웃 주민들의 주장입니다." },
      { start: 56.7, end: 57.7, original: "주장입니다." },
      { start: 70, end: 71, original: "주장입니다." },
    ]);
    expect(out.map((cue) => [cue.start, cue.end, cue.original])).toEqual([
      [55.7, 57.7, "이웃 주민들의 주장입니다."],
      [70, 71, "주장입니다."],
    ]);
  });
});

describe("padLines", () => {
  it("keeps lines up for at least a second without overlapping the next", () => {
    const out = padLines([
      { start: 0, end: 0.3, original: "a" },
      { start: 0.6, end: 0.8, original: "b" },
      { start: 5, end: 5.2, original: "c" },
    ]);
    expect(out.map((cue) => [cue.start, cue.end])).toEqual([
      [0, 0.6],
      [0.6, 1.6],
      [5, 6],
    ]);
  });

  it("bridges small gaps and does not mutate its input", () => {
    const input = [
      { start: 0, end: 2, original: "a" },
      { start: 2.3, end: 4, original: "b" },
    ];
    const out = padLines(input);
    expect(out[0]!.end).toBe(2.3);
    expect(input[0]!.end).toBe(2);
  });
});

describe("whisperToCues", () => {
  it("uses word timings, filters hallucinations and probable non-speech", () => {
    const cues = whisperToCues({
      language: "japanese",
      segments: [
        { start: 0, end: 4, text: "おはようございます", no_speech_prob: 0.1, avg_logprob: -0.2 },
        { start: 4, end: 8, text: "ご視聴ありがとうございました" },
        { start: 8, end: 12, text: "うーん", no_speech_prob: 0.9, avg_logprob: -1.2 },
      ],
      words: [
        { word: "おはよう", start: 1.2, end: 1.8 },
        { word: "ございます", start: 1.8, end: 2.6 },
      ],
    });
    expect(cues).toEqual([{ start: 1.2, end: 2.6, original: "おはようございます" }]);
  });

  it("splits a long segment using its words", () => {
    const kana = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ"];
    const text = kana.join("");
    const words = kana.map((word, i) => ({
      word,
      start: i * 0.2,
      end: i * 0.2 + 0.2,
    }));
    const cues = whisperToCues({ segments: [{ start: 0, end: 6, text }], words });
    expect(cues.length).toBe(2);
  });

  it("falls back to plain text when there are no segments", () => {
    expect(whisperToCues({ text: "hello", duration: 3 })).toEqual([
      { start: 0, end: 3, original: "hello" },
    ]);
    expect(whisperToCues({})).toEqual([]);
  });

  it("knows the common hallucinations", () => {
    expect(isHallucination("チャンネル登録よろしく")).toBe(true);
    expect(isHallucination("시청해 주셔서 감사합니다")).toBe(true);
    expect(isHallucination("今日はいい天気")).toBe(false);
  });
});
