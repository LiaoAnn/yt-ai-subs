import { describe, expect, it } from "vitest";
import {
  HOLD_MS,
  LENGTH_TOLERANCE,
  MediaSourceGate,
  classifyMediaSource,
  keepSegment,
  lengthSecondsOf,
  type MediaSourceFacts,
} from "./media-source-kind";

const facts = (over: Partial<MediaSourceFacts>): MediaSourceFacts => ({
  duration: NaN,
  mainLength: 213,
  adSeen: false,
  attached: true,
  adShowing: false,
  ageMs: 0,
  ...over,
});

describe("classifyMediaSource", () => {
  it("takes a MediaSource whose duration is the video's length as the main one", () => {
    expect(classifyMediaSource(facts({ duration: 213 }))).toBe("main");
    expect(classifyMediaSource(facts({ duration: 213.061 }))).toBe("main");
  });

  it("keeps the main video once ad-showing, still set after a pre-roll, clears", () => {
    // Captured: the main MediaSource was created while ad-showing was still set.
    expect(classifyMediaSource(facts({ duration: 213, adSeen: true, adShowing: true }))).toBe(
      "pending",
    );
    expect(classifyMediaSource(facts({ duration: 213, adSeen: true }))).toBe("main");
  });

  it("does not take an ad as long as the video for the main one", () => {
    const sameLength = { duration: 30, mainLength: 30, adSeen: true, adShowing: true };
    // Held while the ad plays, however long...
    expect(classifyMediaSource(facts({ ...sameLength, ageMs: 4 * HOLD_MS }))).toBe("pending");
    // ...and an ad once the main video's MediaSource replaces it on the <video>.
    expect(classifyMediaSource(facts({ ...sameLength, adShowing: false, attached: false }))).toBe(
      "ad",
    );
  });

  it("takes a MediaSource with another duration, seen during an ad, as an ad", () => {
    expect(classifyMediaSource(facts({ duration: 15, adSeen: true }))).toBe("ad");
  });

  it("holds a MediaSource whose duration is not set yet, even during an ad", () => {
    expect(classifyMediaSource(facts({ adSeen: true }))).toBe("pending");
  });

  it("holds an ad whose appends come before ad-showing is set", () => {
    expect(classifyMediaSource(facts({ duration: 15, ageMs: 300 }))).toBe("pending");
  });

  it("falls back to the per-append ad-showing rule when it cannot tell", () => {
    // A live stream (infinite duration, no length), or no player response seen.
    expect(classifyMediaSource(facts({ duration: Infinity, mainLength: null }))).toBe("pending");
    expect(
      classifyMediaSource(facts({ duration: Infinity, mainLength: null, ageMs: HOLD_MS })),
    ).toBe("fallback");
    expect(classifyMediaSource(facts({ duration: 99, mainLength: null, adSeen: true }))).toBe(
      "pending",
    );
    expect(classifyMediaSource(facts({ duration: 99, ageMs: HOLD_MS }))).toBe("fallback");
  });
});

describe("keepSegment", () => {
  it("passes every main segment and no ad or unclassified one", () => {
    expect(keepSegment("main", true)).toBe(true);
    expect(keepSegment("ad", false)).toBe(false);
    expect(keepSegment("pending", false)).toBe(false);
  });

  it("drops fallback segments appended during an ad", () => {
    expect(keepSegment("fallback", false)).toBe(true);
    expect(keepSegment("fallback", true)).toBe(false);
  });
});

describe("lengthSecondsOf", () => {
  it("reads videoDetails.lengthSeconds", () => {
    expect(lengthSecondsOf({ videoDetails: { videoId: "abc", lengthSeconds: "213" } })).toEqual({
      videoId: "abc",
      seconds: 213,
    });
  });

  it("ignores live streams and responses without details", () => {
    expect(lengthSecondsOf({ videoDetails: { videoId: "abc", lengthSeconds: "0" } })).toBeNull();
    expect(lengthSecondsOf({ adPlacements: [] })).toBeNull();
    expect(lengthSecondsOf(null)).toBeNull();
  });
});

describe("classification boundaries", () => {
  it("matches the length within the tolerance, both ways, and not beyond", () => {
    expect(classifyMediaSource(facts({ duration: 213 + LENGTH_TOLERANCE }))).toBe("main");
    expect(classifyMediaSource(facts({ duration: 213 - LENGTH_TOLERANCE }))).toBe("main");
    expect(classifyMediaSource(facts({ duration: 213 + LENGTH_TOLERANCE + 0.01 }))).toBe("pending");
    expect(classifyMediaSource(facts({ duration: 213 - LENGTH_TOLERANCE - 0.01 }))).toBe("pending");
  });

  it("holds until HOLD_MS, and positive evidence still wins after it", () => {
    expect(classifyMediaSource(facts({ duration: 99, ageMs: HOLD_MS - 1 }))).toBe("pending");
    expect(classifyMediaSource(facts({ duration: 99, ageMs: HOLD_MS }))).toBe("fallback");
    expect(classifyMediaSource(facts({ duration: 213, ageMs: 10 * HOLD_MS }))).toBe("main");
    expect(classifyMediaSource(facts({ duration: 15, adSeen: true, ageMs: 10 * HOLD_MS }))).toBe(
      "ad",
    );
  });
});

const seen = (over: Partial<Parameters<MediaSourceGate<string>["update"]>[0]>) => ({
  duration: NaN,
  mainLength: 213,
  attached: true,
  adShowing: false,
  now: 0,
  ...over,
});

describe("MediaSourceGate", () => {
  it("releases held main segments once, in append order, then passes new ones", () => {
    const gate = new MediaSourceGate<string>(0);
    expect(gate.update(seen({}))).toEqual([]);
    expect(gate.offer("init", true)).toEqual([]);
    expect(gate.offer("a", false)).toEqual([]);
    expect(gate.update(seen({ duration: 213, now: 100 }))).toEqual(["init", "a"]);
    expect(gate.settled).toEqual({ kept: 2, dropped: 0 });
    expect(gate.update(seen({ duration: 213, now: 200 }))).toEqual([]);
    expect(gate.offer("b", true)).toEqual(["b"]);
  });

  it("drops everything an ad appended, also before ad-showing was set", () => {
    const gate = new MediaSourceGate<string>(0);
    gate.update(seen({ duration: 15 }));
    expect(gate.offer("init", false)).toEqual([]);
    expect(gate.offer("a", false)).toEqual([]);
    // ad-showing appears a second later while the ad's MediaSource is on the <video>.
    expect(gate.update(seen({ duration: 15, adShowing: true, now: 1000 }))).toEqual([]);
    expect(gate.kind).toBe("ad");
    expect(gate.settled).toEqual({ kept: 0, dropped: 2 });
    expect(gate.offer("b", false)).toEqual([]);
  });

  it("filters fallback segments by ad-showing at their own append", () => {
    const gate = new MediaSourceGate<string>(0);
    gate.offer("x", false);
    gate.offer("ad", true);
    gate.offer("y", false);
    expect(gate.update(seen({ duration: Infinity, mainLength: null, now: HOLD_MS }))).toEqual([
      "x",
      "y",
    ]);
    expect(gate.offer("ad2", true)).toEqual([]);
    expect(gate.offer("z", false)).toEqual(["z"]);
  });

  it("keeps the main video created while ad-showing lingers after a pre-roll", () => {
    const gate = new MediaSourceGate<string>(0);
    gate.update(seen({ duration: 213, adShowing: true }));
    expect(gate.offer("init", true)).toEqual([]);
    expect(gate.update(seen({ duration: 213, now: 100 }))).toEqual(["init"]);
    expect(gate.kind).toBe("main");
  });

  it("drops an ad as long as the video once the main video replaces it", () => {
    const gate = new MediaSourceGate<string>(0);
    const ad = { duration: 213, adShowing: true };
    gate.update(seen(ad));
    gate.offer("init", true);
    expect(gate.update(seen({ ...ad, now: 20_000 }))).toEqual([]);
    expect(gate.kind).toBe("pending");
    expect(gate.update(seen({ duration: 213, attached: false, now: 30_000 }))).toEqual([]);
    expect(gate.kind).toBe("ad");
  });
});
