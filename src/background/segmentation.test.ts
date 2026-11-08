import { describe, expect, it } from "vitest";
import {
  groupWords,
  dropRepeatedTails,
  isHallucination,
  joinWord,
  mergeBrokenSegments,
  mergeHurriedLines,
  wordsBySegment,
  padLines,
  rejectReason,
  repetitiveFallbacks,
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

// Whisper's Japanese words are often single characters; build them from a string where
// "|" separates tokens and a leading space marks Whisper's phrase gap.
const tokens = (text: string, step = 0.15) =>
  text.split("|").map((word, i) => ({ text: word, start: i * step, end: (i + 1) * step }));

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

  it("splits CJK lines that get too long into balanced lines", () => {
    const words = Array.from({ length: 30 }, (_, i) => ({
      text: "あ",
      start: i * 0.1,
      end: i * 0.1 + 0.1,
    }));
    const lines = groupWords(words);
    expect(lines.map((line) => [...line.original].length)).toEqual([15, 15]);
  });

  it("breaks at Whisper's phrase gaps and particles, never inside a word or number", () => {
    const lines = groupWords(
      tokens(
        "レ|ー|ザ|ー|を|拡|散|さ|せ|ない|ように|高|コ|ヒ|ー|レ|ン|ト|な|状|態|を|維|持|し|な|が|ら|1000|キ|ロ|2000|キ|ロ|先|まで",
      ),
    );
    const text = lines.map((line) => line.original);
    expect(text.join("")).toBe(
      "レーザーを拡散させないように高コヒーレントな状態を維持しながら1000キロ2000キロ先まで",
    );
    expect(text.length).toBe(2);
    for (const line of text) {
      expect(line).not.toMatch(/^[ーロ]|^\d|[ヒレ]$/);
    }
    const spaced = groupWords(
      tokens("まあ|4.7|億|じゃ|何|も|でき|ん|な| あの|本当|に|宇宙|戦略|基金|とか|その|辺|取って"),
    );
    expect(spaced.map((line) => line.original)).toEqual([
      "まあ4.7億じゃ何もできんな",
      "あの本当に宇宙戦略基金とかその辺取って",
    ]);
  });

  it("ends a line at punctuation that comes as its own word", () => {
    const lines = groupWords(tokens("今日は|晴れ|です|ね|。|明日|は|雨"));
    expect(lines.map((line) => line.original)).toEqual(["今日は晴れですね。", "明日は雨"]);
  });

  it("ignores the silence a stretched first or last word absorbed", () => {
    const [line] = groupWords([
      { text: " レ", start: 1, end: 3 },
      { text: "ーザー", start: 3, end: 3.4 },
      { text: "です", start: 3.4, end: 6 },
    ]);
    expect(line!.start).toBeCloseTo(2.4);
    expect(line!.end).toBeCloseTo(4.2);
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
    expect(isHallucination("MBC 뉴스 김성현입니다.")).toBe(true);
    expect(isHallucination("MBC 뉴스를 봤어요")).toBe(false);
    expect(isHallucination("MBC 뉴스 김성현입니다. 오늘의 날씨입니다")).toBe(false);
    expect(isHallucination("今日はいい天気")).toBe(false);
    expect(isHallucination("〈字幕〉")).toBe(true);
    expect(isHallucination("[音楽]")).toBe(true);
    expect(isHallucination("(笑) そうですね")).toBe(false);
    expect(isHallucination("「はい」")).toBe(false);
  });
});

describe("rejectReason (made-up text over music and silence)", () => {
  const speech = { start: 0, end: 4, text: "今日はいい天気ですね", temperature: 0 };
  const ok = { noWords: false, prompt: "", repeats: 0, repetitive: false };

  it("keeps ordinary speech", () => {
    expect(rejectReason(speech, ok)).toBe("");
  });

  it("drops segments without any aligned word, or of a looping fallback window", () => {
    expect(rejectReason(speech, { ...ok, noWords: true })).toBe("no words");
    expect(rejectReason(speech, { ...ok, repetitive: true })).toBe("repetitive fallback decode");
  });

  it("drops an unsure fallback decode, but not the same confidence at temperature 0", () => {
    const listed = { start: 0, end: 3, text: "エビの皮", avg_logprob: -0.81 };
    expect(rejectReason({ ...listed, temperature: 0.4 }, ok)).toBe("unsure fallback decode");
    expect(rejectReason({ ...listed, temperature: 0 }, ok)).toBe("");
    expect(rejectReason({ ...listed, temperature: 0.4, avg_logprob: -0.8 }, ok)).toBe("");
    expect(rejectReason({ ...listed, temperature: 0.4, avg_logprob: -0.7 }, ok)).toBe("");
  });

  it("drops a third identical segment in a row and long repeats of the prompt", () => {
    expect(rejectReason(speech, { ...ok, repeats: 1 })).toBe("");
    expect(rejectReason(speech, { ...ok, repeats: 2 })).toBe("repeated segment");
    expect(rejectReason(speech, { ...ok, prompt: "前の行。今日は、いい天気ですね。" })).toBe(
      "repeats the prompt",
    );
    expect(rejectReason({ ...speech, text: "15,000원" }, { ...ok, prompt: "15,000원?" })).toBe("");
  });

  it("drops segments the decoder itself counts as failed", () => {
    expect(rejectReason({ ...speech, avg_logprob: -1.4 }, ok)).toBe("low confidence");
  });
});

/** One Whisper decode window: segments sharing their decode statistics. */
const window = (texts: string[], temperature: number) =>
  texts.map((text, i) => ({
    start: i,
    end: i + 1,
    text,
    temperature,
    compression_ratio: 2,
    avg_logprob: -0.5,
  }));
const say = (start: number) => ({ start, end: start + 0.5, text: "15,000원?" });

describe("repetitiveFallbacks", () => {
  it("flags a fallback window that loops on near-identical sentences", () => {
    const music = window(
      [
        "私は朝食を食べるために、",
        "私は朝食を早く食べます。",
        "私は朝食を食べる必要があります。",
        "私は朝食を食べます。",
      ],
      0.6,
    );
    expect(repetitiveFallbacks(music).size).toBe(4);
    // The same text decoded at temperature 0 is left to the other checks.
    expect(
      repetitiveFallbacks(
        window(
          music.map((s) => s.text),
          0,
        ),
      ).size,
    ).toBe(0);
  });

  it("keeps a fallback window of varied speech even if it ends in a repeated word", () => {
    const talk = window(
      [
        "아, 이거 진짜 짜증나게.",
        "이걸 2만 원에 못 뒀다.",
        "갤러리에 들어가셔서 지령을 확인해 볼 수 있나요?",
        "이거.",
        "이거.",
        "이거.",
      ],
      0.4,
    );
    expect(repetitiveFallbacks(talk).size).toBe(0);
  });

  it("keeps real speech that shares a looping window with made-up text", () => {
    const mixed = window(
      [
        "アンケートのご協力お願いします",
        "私は朝食を食べるために、",
        "私は朝食を早く食べます。",
        "私は朝食を食べる必要があります。",
        "私は朝食を食べます。",
      ],
      0.6,
    );
    const flagged = repetitiveFallbacks(mixed);
    expect(flagged.has(mixed[0]!)).toBe(false);
    expect(flagged.size).toBe(4);
  });

  it("keeps a long fallback window of real talk whose sentences share a sequence or two", () => {
    // LKTOWTc9l1E 182 s: real talk at temperature 0.2, 183 characters, distinctPairs 0.74
    const talk = window(
      [
        "みんなペコーラに貢なー",
        "いいの?早くペコちゃんに貢がないと ほらー",
        "いやもうカナタちゃんのこの笑顔好きなんだよね",
        "私はまな板です この ほら見て この笑顔",
        "たまらない なんかもう私はこうなのです",
        "これが僕なのです もう最高",
        "ペコーラはこのゲームをやるにあたって 思ったもん",
        "笑顔って他にいないんかなと思いつつも ちゃんとこんなににっこり笑ってるのは",
        "カナタちゃんのみ もう諦めてるのかな",
      ],
      0.2,
    );
    expect(repetitiveFallbacks(talk).size).toBe(0);
  });
});

describe("whisperToCues across segments", () => {
  it("joins a tiny segment to its neighbour instead of showing it alone", () => {
    const words = [
      { word: "それ", start: 0, end: 0.3 },
      { word: "も", start: 0.3, end: 0.5 },
      { word: "本当", start: 0.5, end: 0.9 },
      { word: "に", start: 0.9, end: 1.1 },
      { word: "難しい", start: 1.1, end: 1.8 },
    ];
    const cues = whisperToCues({
      segments: [
        { start: 0, end: 0.5, text: "それも" },
        { start: 0.5, end: 1.8, text: "本当に難しい" },
      ],
      words,
    });
    expect(cues.map((cue) => cue.original)).toEqual(["それも本当に難しい"]);
  });

  it("keeps a line said twice (two speakers) but drops a third repeat in a row", () => {
    const cues = whisperToCues({
      segments: [say(0), say(0.6), say(1.2)],
      words: [0, 0.6, 1.2].map((start) => ({ word: "15,000원?", start, end: start + 0.5 })),
    });
    expect(cues.map((cue) => cue.original)).toEqual(["15,000원? 15,000원?"]);
  });

  it("drops the third and later copies of a looping segment", () => {
    const loop = [0, 5, 10, 15].map((start) => ({
      start,
      end: start + 2,
      text: "このビジュアルを使用しています",
    }));
    const cues = whisperToCues({
      segments: loop,
      words: loop.map((s) => ({ word: s.text, start: s.start + 0.2, end: s.end - 0.2 })),
    });
    expect(cues.length).toBe(2);
  });
});

describe("mergeHurriedLines", () => {
  it("joins lines that follow too fast to read, while they fit", () => {
    const out = mergeHurriedLines([
      { start: 175.1, end: 175.9, original: "15,000원?" },
      { start: 175.5, end: 176.4, original: "15,000원." },
      { start: 176.4, end: 177.2, original: "15,000원 나왔습니다." },
      { start: 180, end: 181, original: "30,000원." },
    ]);
    expect(out.map((cue) => [cue.start, cue.end, cue.original])).toEqual([
      [175.1, 176.4, "15,000원? 15,000원."],
      [176.4, 177.2, "15,000원 나왔습니다."],
      [180, 181, "30,000원."],
    ]);
  });
});

describe("wordsBySegment", () => {
  it("matches words to segments by text, even when speakers overlap in time", () => {
    const segments = [
      { start: 0, end: 3, text: "懐かしいな" },
      { start: 1, end: 2, text: "ははは" },
    ];
    const words = [
      { text: "懐", start: 0.2, end: 0.4 },
      { text: "かしい", start: 1.5, end: 1.8 },
      { text: "な", start: 1.8, end: 2 },
      { text: "ははは", start: 1.1, end: 1.6 },
    ];
    expect(wordsBySegment(segments, words).map((own) => own.map((w) => w.text).join(""))).toEqual([
      "懐かしいな",
      "ははは",
    ]);
  });

  it("falls back to times when the texts do not line up", () => {
    const own = wordsBySegment(
      [
        { start: 0, end: 1, text: "a b" },
        { start: 1, end: 2, text: "c" },
      ],
      [
        { text: "a", start: 0.1, end: 0.5 },
        { text: "x", start: 1.2, end: 1.5 },
      ],
    );
    expect(own.map((w) => w.map((x) => x.text))).toEqual([["a"], ["x"]]);
  });
});
