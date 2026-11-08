import { describe, expect, it } from "vitest";
import {
  VIDEO_TERMS_TOKENS,
  WHISPER_PROMPT_TOKENS,
  buildWhisperPrompt,
  cleanTitle,
  estimateWhisperTokens,
  videoInfoFrom,
  videoPromptPart,
  videoTerms,
  type VideoInfo,
} from "./video-context";

const info = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  videoId: "abc",
  title: "지석진의 핑계 [ENG SUB] #핑계고 #유재석",
  channel: "뜬뜬 DdeunDdeun",
  description: [
    "오늘의 핑계고!",
    "출연: 유재석, 지석진 (Ji Suk-jin), 양세찬",
    "https://www.youtube.com/watch?v=xyz",
    "편집 PD 김철수",
    "#핑계고 #풍향고 #조세호",
  ].join("\n"),
  keywords: ["유재석", "yoo jae suk", "핑계고", "talk show"],
  ...over,
});

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

describe("videoTerms", () => {
  it("keeps the cast, then hashtags, then tags in the source script, unless in the title", () => {
    expect(videoTerms(info(), "ko")).toEqual(["유재석", "양세찬", "핑계고", "풍향고", "조세호"]);
  });

  it("leaves out URLs, credits that are not a cast list, and terms in the title", () => {
    const terms = videoTerms(info(), "ko");
    expect(terms.join(" ")).not.toMatch(/https|김철수|지석진/);
  });

  it("keeps tags in any script when the language is automatic", () => {
    expect(videoTerms(info(), "auto")).toContain("yoo jae suk");
    expect(videoTerms(info(), "ko")).not.toContain("yoo jae suk");
  });

  it("reads Japanese cast lines", () => {
    const ja = info({
      title: "ハウリングラブ 第1話",
      channel: "ドラマ公式",
      description: "【出演】山田太郎・佐藤花子\nゲスト：鈴木一郎",
      keywords: [],
    });
    expect(videoTerms(ja, "ja")).toEqual(["山田太郎", "佐藤花子", "鈴木一郎"]);
  });
});

describe("cleanTitle", () => {
  it("drops hashtags, emoji and ASCII tags in brackets but keeps the rest", () => {
    expect(cleanTitle("🔥[ENG SUB] 지석진의 핑계 (EP.12) #핑계고")).toBe("지석진의 핑계");
    expect(cleanTitle("[핑계고] 오늘")).toBe("[핑계고] 오늘");
    expect(cleanTitle("全員が恋愛対象｜Howling Love〈字幕：English・簡体・繁体・한국어〉")).toBe(
      "全員が恋愛対象｜Howling Love",
    );
    expect(cleanTitle("[SUB][너의연애] 탐색전")).toBe("[너의연애] 탐색전");
  });
});

describe("buildWhisperPrompt", () => {
  it("puts the video's title, channel and terms before the recent captions", () => {
    const prompt = buildWhisperPrompt(info(), "아까 그 얘기 말이야", "ko");
    expect(prompt).toBe(
      "지석진의 핑계. 뜬뜬 DdeunDdeun. 유재석, 양세찬, 핑계고, 풍향고, 조세호. 아까 그 얘기 말이야",
    );
  });

  it("stays within Whisper's prompt limit, keeping the end of long captions", () => {
    const recent = "가나다라마바사 ".repeat(60) + "마지막 문장";
    const prompt = buildWhisperPrompt(info(), recent, "ko");
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(WHISPER_PROMPT_TOKENS);
    expect(prompt.endsWith("마지막 문장")).toBe(true);
    expect(prompt.startsWith("지석진의 핑계.")).toBe(true);
  });

  it("caps the video part, dropping terms that do not fit", () => {
    const many = info({
      description: `출연: ${Array.from({ length: 40 }, (_, i) => `출연자${i}`).join(", ")}`,
    });
    const part = videoPromptPart(many, "ko");
    expect(estimateWhisperTokens(part)).toBeLessThanOrEqual(VIDEO_TERMS_TOKENS);
    expect(part).toContain("출연자0");
    expect(part).not.toContain("출연자39");
  });

  it("works without video info, as the recent captions alone", () => {
    expect(buildWhisperPrompt(undefined, "こんにちは", "ja")).toBe("こんにちは");
    expect(buildWhisperPrompt(undefined, "", "ja")).toBe("");
    expect(buildWhisperPrompt(info(), "", "ko").endsWith("조세호.")).toBe(true);
  });

  it("does not start a cut caption tail in the middle of a word", () => {
    const prompt = buildWhisperPrompt(undefined, "alpha ".repeat(200) + "omega", "en", 20);
    expect(prompt.split(" ").every((word) => word === "alpha" || word === "omega")).toBe(true);
    expect(estimateWhisperTokens(prompt)).toBeLessThanOrEqual(20);
  });
});
