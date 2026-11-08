import { describe, expect, it } from "vitest";
import {
  asrTrack,
  creatorLines,
  groundTruth,
  isTraditional,
  overlapLength,
  speechIntervals,
  unionLength,
  type FetchedVideo,
  type Json3,
} from "./ground-truth";

const PHRASES = [
  "今日はいい天気ですね",
  "そうですね本当に",
  "どこに行きましょうか",
  "海に行きたいです",
  "いいですね行こう",
];

/** A creator track: one line per phrase, every 4 s from 10 s, `shift` seconds off the speech. */
function creator(texts: readonly string[], shift = 0, gap = 1): Json3 {
  return {
    events: texts.map((text, i) => ({
      tStartMs: Math.round((10 + i * 4 + shift) * 1000),
      dDurationMs: (4 - gap) * 1000,
      segs: [{ utf8: text }],
    })),
  };
}

/** YouTube's automatic track: the same phrases, with a newline event between them. */
function asr(texts: readonly string[]): Json3 {
  return {
    events: [
      { tStartMs: 0, dDurationMs: 100000 },
      ...texts.flatMap((text, i) => [
        {
          tStartMs: (10 + i * 4) * 1000,
          dDurationMs: 5000,
          segs: [{ utf8: text.slice(0, 4) }, { utf8: text.slice(4), tOffsetMs: 800 }],
        },
        {
          tStartMs: (10 + i * 4) * 1000 + 3500,
          dDurationMs: 10,
          aAppend: 1,
          segs: [{ utf8: "\n" }],
        },
      ]),
    ],
  };
}

function video(tracks: FetchedVideo["tracks"]): FetchedVideo {
  return { videoId: "test", lengthSeconds: 40, tracks };
}

const many = (texts: readonly string[], n: number) =>
  Array.from({ length: n }, (_, i) => texts[i % texts.length]!);

describe("json3 parsing", () => {
  it("reads creator lines in seconds", () => {
    expect(creatorLines(creator(["あ", "い"]))[1]).toEqual({ start: 14, end: 17, text: "い" });
  });

  it("reads automatic phrases and word starts, ending each phrase where the next starts", () => {
    const track = asrTrack(asr(PHRASES.slice(0, 2)));
    expect(track.lines.map((l) => [l.start, l.end])).toEqual([
      [10, 14],
      [14, 19],
    ]);
    expect(track.words.map((w) => w.start)).toEqual([10, 10.8, 14, 14.8]);
    expect(track.wordTimed).toBe(1);
  });
});

describe("intervals", () => {
  it("measures unions and overlaps", () => {
    const xs = [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ];
    expect(unionLength(xs)).toBe(4);
    expect(overlapLength({ start: 1.5, end: 5.5 }, xs)).toBe(2);
    expect(
      speechIntervals([
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ]),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ]);
  });
});

describe("groundTruth trap rules", () => {
  const texts = many(PHRASES, 25);

  it("accepts a verbatim creator track with its own timing", () => {
    const g = groundTruth(
      video([
        { languageCode: "ja", kind: null, vssId: ".ja", json: creator(texts, -0.15) },
        { languageCode: "ja", kind: "asr", vssId: "a.ja", json: asr(texts) },
      ]),
      "ja",
    );
    expect(g.flags).toEqual([]);
    expect(g.supports).toEqual({ cer: true, recall: true, precision: true, translation: false });
    expect(g.stats?.startOffset.median).toBeCloseTo(-0.15);
  });

  it("drops a creator track that copies the automatic one", () => {
    const g = groundTruth(
      video([
        { languageCode: "ja", kind: null, vssId: ".ja", json: creator(texts) },
        { languageCode: "ja", kind: "asr", vssId: "a.ja", json: asr(texts) },
      ]),
      "ja",
    );
    expect(g.flags).toContain("copy of the automatic track");
    expect(g.supports).toEqual({ cer: false, recall: false, precision: false, translation: false });
  });

  it("keeps the text but not the timing when YouTube aligned a hand-made track", () => {
    const edited = texts.map((t, i) =>
      i % 2 ? t.replace(/ね/g, "よ").replace("本当", "ほんと") : t.replace("天気", "てんき"),
    );
    const g = groundTruth(
      video([
        { languageCode: "ja", kind: null, vssId: ".ja", json: creator(edited) },
        { languageCode: "ja", kind: "asr", vssId: "a.ja", json: asr(texts) },
      ]),
      "ja",
    );
    expect(g.flags).toContain("timing aligned by YouTube");
    expect(g.supports.cer).toBe(true);
    expect(g.supports.recall).toBe(false);
  });

  it("uses a translation track for speech recall and as the reference", () => {
    const zh = many(
      ["今天天氣很好呢", "對啊真的是這樣", "我們要去哪裡呢", "我想去海邊看看", "好啊我們走吧"],
      25,
    );
    const g = groundTruth(
      video([
        { languageCode: "zh-Hant", kind: null, vssId: ".zh-Hant", json: creator(zh, 0.1) },
        { languageCode: "ja", kind: "asr", vssId: "a.ja", json: asr(texts) },
      ]),
      "ja",
    );
    expect(g.flags).toContain("translation track only");
    expect(g.supports).toEqual({ cer: false, recall: true, precision: false, translation: true });
    expect(g.reference?.vssId).toBe(".zh-Hant");
  });

  it("falls back to the automatic track as weak speech labels, for recall only", () => {
    const g = groundTruth(
      video([{ languageCode: "ja", kind: "asr", vssId: "a.ja", json: asr(texts) }]),
      "ja",
    );
    expect(g.source).toEqual({ vssId: "a.ja", kind: "automatic" });
    expect(g.flags[0]).toMatch(/automatic track only/);
    expect(g.supports).toEqual({ cer: false, recall: true, precision: false, translation: false });
    expect(g.lines.length).toBe(25);
  });

  it("tells Traditional from Simplified Chinese", () => {
    expect(isTraditional([{ start: 0, end: 1, text: "這個時候我們說過會來這裡" }])).toBe(true);
    expect(isTraditional([{ start: 0, end: 1, text: "这个时候我们说过会来这里" }])).toBe(false);
  });
});
