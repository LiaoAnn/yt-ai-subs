import { describe, expect, it } from "vitest";
import {
  WHISPER_PROMPT_TOKENS,
  buildWhisperPrompt,
  estimateWhisperTokens,
  videoInfoFrom,
} from "./video-context";

describe("videoInfoFrom", () => {
  it("reads title, channel, description and tags from a player response", () => {
    const response = {
      videoDetails: {
        videoId: "abc",
        title: "T",
        author: "C",
        shortDescription: "D",
        keywords: ["a", 3, "b"],
      },
    };
    expect(videoInfoFrom(response)).toEqual({
      videoId: "abc",
      title: "T",
      channel: "C",
      description: "D",
      keywords: ["a", "b"],
    });
    expect(videoInfoFrom({})).toBeNull();
    expect(videoInfoFrom({ videoDetails: { title: "no id" } })).toBeNull();
  });
});

describe("buildWhisperPrompt", () => {
  // The video's title, channel, description and tags at the front of the prompt made
  // Whisper decode garbage on some videos (cth3M1iavGM, dZgXCAWnz2c): it gets the recent
  // captions and nothing else.
  it("takes only the recent captions, no video info", () => {
    expect(buildWhisperPrompt.length).toBe(1);
    expect(buildWhisperPrompt("아까 그 얘기 말이야")).toBe("아까 그 얘기 말이야");
    expect(buildWhisperPrompt("  こんにちは ")).toBe("こんにちは");
    expect(buildWhisperPrompt("")).toBe("");
    expect(buildWhisperPrompt("   ")).toBe("");
  });

  it("is always the end of the recent captions, within Whisper's prompt limit", () => {
    for (const recent of [
      "가나다라마바사 ".repeat(60) + "마지막 문장",
      "今日はいい天気ですね。".repeat(40),
      "alpha beta gamma ".repeat(100),
    ]) {
      const prompt = buildWhisperPrompt(recent);
      expect(recent.trim().endsWith(prompt)).toBe(true);
      expect(prompt.length).toBeGreaterThan(0);
      expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(WHISPER_PROMPT_TOKENS);
    }
  });

  it("does not start a cut caption tail in the middle of a word", () => {
    const prompt = buildWhisperPrompt("alpha ".repeat(200) + "omega", 20);
    expect(prompt.split(" ").every((word) => word === "alpha" || word === "omega")).toBe(true);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(20);
  });
});
