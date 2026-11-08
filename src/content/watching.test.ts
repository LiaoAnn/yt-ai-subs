import { describe, expect, it } from "vitest";
import { AD_PAUSE_REASON, HIDDEN_PAUSE_REASON, schedulingPause } from "./watching";

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
});
