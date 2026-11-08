import { describe, expect, it } from "vitest";
import { newSpan } from "@/page/ranges";
import { toJson3 } from "./captions";
import { PAGE_COMMAND_TAG, PAGE_MESSAGE_TAG, isPageCommand, isPageMessage } from "./messages";
import { DEFAULT_SETTINGS } from "./settings";
import { DEFAULT_TRACK_CONFIG, parseTrackConfig, trackConfigFromSettings } from "./track-config";
import { unsupportedReason, videoIdFromUrl } from "./youtube";

describe("toJson3", () => {
  it("maps cues to timedtext events in milliseconds", () => {
    const cues = [
      { start: 3, end: 4.5, original: "二番目", translation: "第二" },
      { start: 1.2345, end: 2, original: "一番目" },
      { start: 5, end: 5, original: "empty duration" },
    ];
    expect(toJson3(cues, "translation")).toEqual({
      wireMagic: "pb3",
      events: [
        { tStartMs: 1235, dDurationMs: 765, segs: [{ utf8: "一番目" }] },
        { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: "第二" }] },
      ],
    });
    expect(toJson3(cues, "original").events.map((e) => e.segs[0]!.utf8)).toEqual([
      "一番目",
      "二番目",
    ]);
  });

  it("puts the original above the translation in a bilingual track", () => {
    const cues = [
      { start: 0, end: 1, original: "原文", translation: "翻譯" },
      { start: 1, end: 2, original: "same", translation: "same" },
      { start: 2, end: 3, original: "まだ" },
    ];
    expect(toJson3(cues, "both").events.map((e) => e.segs[0]!.utf8)).toEqual([
      "原文\n翻譯",
      "same",
      "まだ",
    ]);
  });
});

describe("track config", () => {
  it("names the track after what it shows", () => {
    expect(trackConfigFromSettings(DEFAULT_SETTINGS)).toEqual({
      enabled: true,
      label: "AI 繁中",
      languageCode: "zh-TW",
      translate: true,
      sourceLanguage: "ja",
    });
    expect(trackConfigFromSettings({ ...DEFAULT_SETTINGS, translate: false })).toEqual({
      enabled: true,
      label: "AI 原文",
      languageCode: "ja",
      translate: false,
      sourceLanguage: "ja",
    });
    expect(
      trackConfigFromSettings({ ...DEFAULT_SETTINGS, translate: false, sourceLanguage: "auto" })
        .languageCode,
    ).toBe("und");
  });

  it("round-trips through localStorage text and survives garbage", () => {
    const config = {
      enabled: false,
      label: "AI 英文",
      languageCode: "en",
      translate: true,
      sourceLanguage: "auto",
    };
    expect(parseTrackConfig(JSON.stringify(config))).toEqual(config);
    expect(parseTrackConfig(null)).toEqual(DEFAULT_TRACK_CONFIG);
    expect(parseTrackConfig("{oops")).toEqual(DEFAULT_TRACK_CONFIG);
    expect(
      parseTrackConfig(
        JSON.stringify({ enabled: "yes", languageCode: "<b>", sourceLanguage: "<i>" }),
      ),
    ).toEqual(DEFAULT_TRACK_CONFIG);
    // Stored by an older version (no translate / sourceLanguage): the defaults fill in.
    expect(
      parseTrackConfig(JSON.stringify({ enabled: true, label: "AI 繁中", languageCode: "zh-TW" })),
    ).toEqual(DEFAULT_TRACK_CONFIG);
  });
});

describe("isPageMessage", () => {
  const segment = {
    [PAGE_MESSAGE_TAG]: true,
    type: "segment",
    bufferId: 1,
    mime: 'audio/webm; codecs="opus"',
    videoId: "abc",
    init: false,
    start: 0,
    end: 5,
    bytes: new ArrayBuffer(4),
  };

  it("accepts well-formed messages", () => {
    expect(isPageMessage({ [PAGE_MESSAGE_TAG]: true, type: "page-ready" })).toBe(true);
    expect(isPageMessage(segment)).toBe(true);
    expect(isPageMessage({ ...segment, start: null, end: null, videoId: null })).toBe(true);
    expect(
      isPageMessage({
        [PAGE_MESSAGE_TAG]: true,
        type: "caption-mode",
        videoId: "abc",
        mode: "overlay",
        reason: "x",
      }),
    ).toBe(true);
  });

  it("rejects untagged or malformed messages", () => {
    expect(isPageMessage({ type: "page-ready" })).toBe(false);
    expect(isPageMessage({ ...segment, bytes: "nope" })).toBe(false);
    expect(isPageMessage({ ...segment, bufferId: 1.5 })).toBe(false);
    expect(isPageMessage({ ...segment, start: Number.NaN })).toBe(false);
    expect(isPageMessage({ [PAGE_MESSAGE_TAG]: true, type: "other" })).toBe(false);
    expect(
      isPageMessage({ [PAGE_MESSAGE_TAG]: true, type: "caption-mode", videoId: "a", mode: "x" }),
    ).toBe(false);
    expect(isPageMessage(null)).toBe(false);
  });
});

describe("isPageCommand", () => {
  const command = {
    [PAGE_COMMAND_TAG]: true,
    type: "track-cues",
    videoId: "abc",
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "字幕" }] }],
  };

  it("accepts track cues and rejects malformed ones", () => {
    expect(isPageCommand(command)).toBe(true);
    expect(isPageCommand({ ...command, events: [] })).toBe(true);
    expect(isPageCommand({ ...command, [PAGE_COMMAND_TAG]: false })).toBe(false);
    expect(isPageCommand({ ...command, events: [{ tStartMs: 0, segs: [] }] })).toBe(false);
    expect(isPageCommand({ ...command, events: [{ ...command.events[0], segs: [{}] }] })).toBe(
      false,
    );
    expect(isPageCommand({ [PAGE_MESSAGE_TAG]: true, type: "page-ready" })).toBe(false);
  });
});

describe("videoIdFromUrl", () => {
  it("reads watch, shorts and embed URLs", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3")).toBe("jNQXAC9IVRw");
    expect(videoIdFromUrl("https://www.youtube.com/shorts/abc123")).toBe("abc123");
    expect(videoIdFromUrl("https://www.youtube.com/embed/xyz?autoplay=1")).toBe("xyz");
    expect(videoIdFromUrl("https://www.youtube.com/")).toBeNull();
    expect(videoIdFromUrl("not a url")).toBeNull();
  });
});

describe("newSpan", () => {
  it("returns the time span an append added to the buffered ranges", () => {
    expect(newSpan([[0, 10]], [[0, 5]])).toEqual([5, 10]);
    expect(
      newSpan(
        [
          [0, 5],
          [20, 25],
        ],
        [[0, 5]],
      ),
    ).toEqual([20, 25]);
    expect(newSpan([[0, 5]], [[0, 5]])).toBeNull();
    expect(newSpan([[0, 5.01]], [[0, 5]])).toBeNull(); // slivers are ignored
  });
});

describe("unsupportedReason", () => {
  it("turns captions off for Shorts and live streams only", () => {
    expect(unsupportedReason("/watch", false)).toBe("");
    expect(unsupportedReason("/shorts/abc123", false)).toBe("Shorts 不支援");
    expect(unsupportedReason("/watch", true)).toBe("直播不支援");
    expect(unsupportedReason("/live/abc123", false)).toBe(""); // a finished stream's VOD
  });
});
