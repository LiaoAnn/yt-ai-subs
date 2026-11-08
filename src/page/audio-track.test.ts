import { describe, expect, it } from "vitest";
import { isAutoDubbed } from "./audio-track";

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
