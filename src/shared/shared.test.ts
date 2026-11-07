import { describe, expect, it } from "vitest";
import { newSpan } from "@/page/ranges";
import { toJson3 } from "./captions";
import { PAGE_MESSAGE_TAG, isPageMessage } from "./messages";
import { videoIdFromUrl } from "./youtube";

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
  });

  it("rejects untagged or malformed messages", () => {
    expect(isPageMessage({ type: "page-ready" })).toBe(false);
    expect(isPageMessage({ ...segment, bytes: "nope" })).toBe(false);
    expect(isPageMessage({ ...segment, bufferId: 1.5 })).toBe(false);
    expect(isPageMessage({ ...segment, start: Number.NaN })).toBe(false);
    expect(isPageMessage({ [PAGE_MESSAGE_TAG]: true, type: "other" })).toBe(false);
    expect(isPageMessage(null)).toBe(false);
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
