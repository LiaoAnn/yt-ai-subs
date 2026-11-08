import { describe, expect, it } from "vitest";
import {
  AD_PAUSE_REASON,
  HIDDEN_PAUSE_REASON,
  TRACK_PAUSE_REASON,
  TRACK_VERDICT_WAIT_MS,
  awaitingTrackVerdict,
  schedulingPause,
} from "./watching";

const state = { adShowing: false, hidden: false, pictureInPicture: false };

describe("schedulingPause", () => {
  it("lets a visible tab schedule", () => {
    expect(schedulingPause(state)).toBeNull();
  });

  it("pauses a hidden tab (background tab or minimised window)", () => {
    expect(schedulingPause({ ...state, hidden: true })).toBe(HIDDEN_PAUSE_REASON);
  });

  it("keeps scheduling a hidden tab whose video is in picture-in-picture", () => {
    expect(schedulingPause({ ...state, hidden: true, pictureInPicture: true })).toBeNull();
  });

  it("pauses during an ad, visible or not", () => {
    expect(schedulingPause({ ...state, adShowing: true })).toBe(AD_PAUSE_REASON);
    expect(schedulingPause({ ...state, adShowing: true, hidden: true })).toBe(AD_PAUSE_REASON);
    expect(schedulingPause({ ...state, adShowing: true, pictureInPicture: true })).toBe(
      AD_PAUSE_REASON,
    );
  });

  it("holds chunks while an audio-track switch is not confirmed yet", () => {
    expect(schedulingPause({ ...state, trackPending: true })).toBe(TRACK_PAUSE_REASON);
  });
});

describe("awaitingTrackVerdict", () => {
  it("waits from a source change until the page script's verdict, at most a while", () => {
    expect(awaitingTrackVerdict(0, false, 5000)).toBe(false); // no change seen
    expect(awaitingTrackVerdict(1000, false, 1500)).toBe(true);
    expect(awaitingTrackVerdict(1000, true, 1500)).toBe(false); // the verdict came
    expect(awaitingTrackVerdict(1000, false, 1000 + TRACK_VERDICT_WAIT_MS)).toBe(false);
  });
});
