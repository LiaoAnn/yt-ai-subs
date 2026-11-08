import { describe, expect, it } from "vitest";
import {
  decisionRows,
  labelSpan,
  scoreCaptions,
  scoreFilters,
  type Truth,
  type WhisperCapture,
} from "./caption-eval";

const truth: Truth = {
  speech: [
    { start: 10, end: 14 },
    { start: 20, end: 24 },
  ],
  lines: [
    { start: 10, end: 14, text: "今日はいい天気ですね" },
    { start: 20, end: 24, text: "海に行きたいです" },
  ],
  anySpeech: [
    { start: 10, end: 14 },
    { start: 20, end: 24 },
  ],
  reference: [
    { start: 10, end: 14, text: "今天天氣真好" },
    { start: 20, end: 24, text: "我想去海邊" },
  ],
  supports: { cer: true, recall: true, precision: true, translation: true },
};

const seg = (start: number, end: number, text: string, extra = {}) => ({
  start,
  end,
  text,
  avg_logprob: -0.2,
  no_speech_prob: 0.01,
  temperature: 0,
  compression_ratio: 1,
  ...extra,
});

function whisperCapture(): WhisperCapture {
  return {
    videoId: "v",
    start: 0,
    end: 30,
    sentSeconds: 30,
    context: "",
    envelope: Array.from({ length: 1500 }, () => -30),
    frameSeconds: 0.02,
    raw: {
      segments: [
        seg(10, 14, "今日はいい天気ですね"),
        seg(20, 24, "海に行きたいです", { avg_logprob: -1.5 }),
        seg(26, 29, "ご視聴ありがとうございました"),
        seg(15, 17, "なにか"),
      ].toSorted((a, b) => a.start - b.start),
    },
    cues: [
      { start: 10.2, end: 13.8, original: "今日はいい天気ですね", translation: "今天天氣真好" },
    ],
  };
}

describe("layer B", () => {
  it("labels spans by creator lines, and as no speech only far from any", () => {
    expect(labelSpan({ start: 10.5, end: 12 }, "", truth)).toBe("speech");
    expect(labelSpan({ start: 26, end: 29 }, "x", truth)).toBe("no speech");
    expect(labelSpan({ start: 14.8, end: 16 }, "x", truth)).toBe("unsure");
    expect(
      labelSpan({ start: 26, end: 29 }, "x", {
        ...truth,
        supports: { ...truth.supports, precision: false },
      }),
    ).toBe("unsure");
  });

  it("counts kept and dropped segments against the labels", () => {
    const rows = decisionRows([whisperCapture()], truth);
    const score = scoreFilters(rows);
    expect(score.keptSpeech).toBe(1);
    expect(score.droppedSpeech).toBe(1); // the low-confidence real line
    expect(score.droppedNoSpeech).toBe(1); // the known phrase over silence
    expect(score.reasons["low confidence"]).toEqual({ speech: 1, "no speech": 0, unsure: 0 });
    expect(score.reasons["known phrase"]).toEqual({ speech: 0, "no speech": 1, unsure: 0 });
  });
});

describe("layer C", () => {
  it("scores coverage, CER, start offsets and chrF of what was shown", () => {
    const c = whisperCapture();
    const score = scoreCaptions([c], c.cues, truth);
    expect(score.window).toEqual({ start: 0, end: 30 });
    expect(score.coverage).toBeCloseTo(3.6 / 8);
    expect(score.cer?.refChars).toBe(18);
    expect(score.cer?.cer).toBeCloseTo(8 / 18, 2); // the second line is missing
    expect(score.start).toMatchObject({ n: 1, median: 0.2 });
    // the line ends the same text, and a pause follows it: 13.8 − 14
    expect(score.end).toMatchObject({ n: 1, median: -0.2 });
    expect(score.chrF).toBeGreaterThan(30);
  });
});
