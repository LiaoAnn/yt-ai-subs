import { describe, expect, it } from "vitest";
import { DubTracker, isAutoDubbed } from "./audio-track";

// Shapes as `movie_player.getAudioTrack()` returned them on dZgXCAWnz2c (2026-11-08).
const dub = {
  id: "251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoNCgRsYW5nEgVlbi1VUw",
  Rb: { id: "en-US.10", isAutoDubbed: true, isDefault: true, name: "English (US)" },
  captionTracks: [],
  xtags: "",
};
const original = {
  id: "251;ChEKBWFjb250EghvcmlnaW5hbAoKCgRsYW5nEgJqYQoHCgJ2YhIBMQ",
  Rb: { id: "ja.4", isAutoDubbed: false, isDefault: false, name: "Japanese original" },
  captionTracks: [],
  xtags: "",
};

describe("isAutoDubbed", () => {
  it("reads the minified part that has isAutoDubbed", () => {
    expect(isAutoDubbed(dub)).toBe(true);
    expect(isAutoDubbed(original)).toBe(false);
  });

  it("falls back to the xtags in the id when the flag is gone", () => {
    expect(isAutoDubbed({ ...dub, Rb: { name: "English (US)" } })).toBe(true);
    expect(isAutoDubbed({ ...original, Rb: { name: "Japanese original" } })).toBe(false);
  });

  it("counts a video without dubs as not dubbed, and no track as unknown", () => {
    expect(isAutoDubbed({ id: "251;", xtags: "" })).toBe(false);
    expect(isAutoDubbed({})).toBe(false);
    expect(isAutoDubbed(undefined)).toBeNull();
    expect(isAutoDubbed(null)).toBeNull();
  });
});

describe("isAutoDubbed precedence", () => {
  it("reads the flag when there is no id, and trusts it over the id", () => {
    expect(isAutoDubbed({ Rb: { isAutoDubbed: true } })).toBe(true);
    expect(isAutoDubbed({ Rb: { isAutoDubbed: false } })).toBe(false);
    expect(isAutoDubbed({ ...original, Rb: { ...original.Rb, isAutoDubbed: true } })).toBe(true);
    expect(isAutoDubbed({ ...dub, Rb: { ...dub.Rb, isAutoDubbed: false } })).toBe(false);
    expect(isAutoDubbed({ id: original.id, isAutoDubbed: true })).toBe(true);
  });
});

describe("DubTracker", () => {
  it("follows the track per video: dub, switch to the original, back to the dub", () => {
    const dubs = new DubTracker();
    expect(dubs.observe("vid", false, null)).toBe(false); // no player yet
    expect(dubs.observe("vid", false, true)).toBe(true);
    expect(dubs.observe("vid", false, null)).toBe(true); // unknown changes nothing
    expect(dubs.observe("vid", false, false)).toBe(false);
    expect(dubs.observe("vid", false, true)).toBe(true);
    expect(dubs.isDubbed("other")).toBe(false);
    expect(dubs.isDubbed(null)).toBe(false);
  });

  it("keeps the video's track during an ad (the player reports the ad's)", () => {
    const dubs = new DubTracker();
    dubs.observe("vid", false, true);
    expect(dubs.observe("vid", true, false)).toBe(true);
    expect(dubs.observe("vid", false, true)).toBe(true);
  });

  it("remembers the most recently changed videos only", () => {
    const dubs = new DubTracker();
    for (let i = 0; i < 20; i++) dubs.observe(`v${i}`, false, true);
    expect(dubs.isDubbed("v0")).toBe(false);
    expect(dubs.isDubbed("v19")).toBe(true);
  });
});
