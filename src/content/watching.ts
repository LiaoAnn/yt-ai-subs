// Whether anyone can see the captions right now, so a chunk is worth sending. Pure logic;
// index.ts reads the page state.

export interface WatchState {
  /** `#movie_player` shows an ad (`ad-showing`). */
  adShowing: boolean;
  /** `document.visibilityState === "hidden"`: a background tab or a minimised window. */
  hidden: boolean;
  /** The video (or a Document Picture-in-Picture window) is shown in picture-in-picture. */
  pictureInPicture: boolean;
}

export const AD_PAUSE_REASON = "廣告中";
export const HIDDEN_PAUSE_REASON = "分頁在背景，暫停送出";

/**
 * Why no new chunk should be sent now, or null if scheduling may go on. In-flight requests
 * are left to finish. A hidden tab with the video in picture-in-picture is still watched;
 * a hidden tab that only plays the audio is not (nobody reads the captions, and autoplay
 * would otherwise spend the day's budget on videos nobody watches).
 */
export function schedulingPause(state: WatchState): string | null {
  if (state.adShowing) return AD_PAUSE_REASON;
  if (state.hidden && !state.pictureInPicture) return HIDDEN_PAUSE_REASON;
  return null;
}
