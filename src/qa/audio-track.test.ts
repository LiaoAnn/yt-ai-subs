import { describe, expect, it } from "vitest";
import { audioProblem, type AudioTrackInfo } from "./audio-track";

const dub: AudioTrackInfo = { name: "English (US)", isDefault: true, isAutoDubbed: true };
const original: AudioTrackInfo = {
  name: "Japanese original",
  isDefault: false,
  isAutoDubbed: false,
};
const plain: AudioTrackInfo = { name: "Default", isDefault: true, isAutoDubbed: false };

describe("audioProblem", () => {
  it("refuses a capture of a dub", () => {
    expect(
      audioProblem({ tracks: [dub, original], current: dub, switched: false }, undefined),
    ).toMatch(/dubbed/);
  });

  it("accepts the original track, also after a switch", () => {
    expect(audioProblem({ tracks: [dub, original], current: original }, undefined)).toBeNull();
    expect(
      audioProblem({ tracks: [dub, original], current: dub, switched: true }, undefined),
    ).toBeNull();
    expect(audioProblem({ tracks: [], current: plain }, undefined)).toBeNull();
  });

  it("refuses an unrecorded capture of a video that has a dub, accepts one that has none", () => {
    expect(audioProblem(undefined, { tracks: [dub, original], current: dub })).toMatch(
      /not recorded/,
    );
    expect(audioProblem(undefined, { tracks: [], current: plain })).toBeNull();
    expect(audioProblem(undefined, undefined)).toBeNull();
  });
});
