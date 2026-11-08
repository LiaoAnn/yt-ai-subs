// Whether anyone can see the captions right now, so a chunk is worth sending. Pure logic;
// index.ts reads the page state.

export interface WatchState {
  /** `#movie_player` shows an ad (`ad-showing`). */
  adShowing: boolean;
  /** `document.visibilityState === "hidden"`: a background tab or a minimised window. */
  hidden: boolean;
  /** The video (or a Document Picture-in-Picture window) is shown in picture-in-picture. */
  pictureInPicture: boolean;
  /**
   * The <video>'s source changed (e.g. the viewer switched the audio track) and the page
   * script has not said yet whether an AI dub plays now (`awaitingTrackVerdict`).
   */
  trackPending?: boolean;
}

export const AD_PAUSE_REASON = "廣告中";
export const HIDDEN_PAUSE_REASON = "分頁在背景，暫停送出";
export const TRACK_PAUSE_REASON = "音軌切換中";

/** How long to wait for the page script's word after a source change, at most (ms). */
export const TRACK_VERDICT_WAIT_MS = 2000;

/**
 * Whether to hold new chunks after the <video>'s source changed at `changedAt` (ms, 0 for
 * never): until a verdict arrived after it (`heard`), at most `TRACK_VERDICT_WAIT_MS`.
 * Switching to an AI dub swaps the source and resets the time to 0; a chunk scheduled in
 * between was sent before the dub verdict (1 of 3 switches back to a dub before this).
 */
export function awaitingTrackVerdict(changedAt: number, heard: boolean, now: number): boolean {
  return changedAt > 0 && !heard && now - changedAt < TRACK_VERDICT_WAIT_MS;
}

/**
 * Why no new chunk should be sent now, or null if scheduling may go on. In-flight requests
 * are left to finish. A hidden tab with the video in picture-in-picture is still watched;
 * a hidden tab that only plays the audio is not (nobody reads the captions, and autoplay
 * would otherwise spend the day's budget on videos nobody watches).
 */
export function schedulingPause(state: WatchState): string | null {
  if (state.adShowing) return AD_PAUSE_REASON;
  if (state.hidden && !state.pictureInPicture) return HIDDEN_PAUSE_REASON;
  if (state.trackPending) return TRACK_PAUSE_REASON;
  return null;
}
