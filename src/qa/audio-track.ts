// YouTube adds AI-dubbed audio tracks to some videos and, in an English browser, plays the
// English dub by default (19 of the 48 videos of the evaluation set have one; 17 played it
// by default in November 2026). A capture of the dub scores Whisper on English speech
// against the creator's Japanese or Korean lines, so the evaluation refuses it. The
// collector (eval-collect.py) records the player's audio track state in every capture file
// and switches to the original track before capturing.

export interface AudioTrackInfo {
  name: string | null;
  isDefault: boolean;
  isAutoDubbed: boolean;
}

/** What the collector saw (`audio` in a capture file, an entry of .qa/audio.json). */
export interface AudioState {
  tracks?: AudioTrackInfo[];
  current?: AudioTrackInfo | null;
  /** The collector switched from a dub to the original track. */
  switched?: boolean;
  error?: string;
}

/**
 * Why a capture cannot be scored because of its audio track, or null when it can:
 * - its own state says a dub played and was not switched away from;
 * - it has no state (made before the check) and the video has a dub track (`video`, from a
 *   separate check of the video's tracks).
 */
export function audioProblem(
  capture: AudioState | undefined,
  video: AudioState | undefined,
): string | null {
  if (capture && !capture.error) {
    if (capture.current?.isAutoDubbed && !capture.switched)
      return "captured an auto-dubbed audio track";
    return null;
  }
  if (video?.tracks?.some((t) => t.isAutoDubbed)) {
    return "audio track not recorded, and the video has an auto-dubbed track";
  }
  return null;
}
