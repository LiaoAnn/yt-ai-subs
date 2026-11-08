// Whether the player plays one of YouTube's AI-dubbed audio tracks. YouTube adds them to some
// videos and, in an English browser, plays the English dub by default (17 of the 48 videos of
// the evaluation set, November 2026). Someone listening to the dub does not need our captions,
// and Whisper would hear English: the extension does nothing while a dub plays.
//
// `movie_player.getAudioTrack()` returns a minified object: `id` (e.g.
// "251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoN…", itag and base64url xtags) and an inner part, found
// by its shape, with `isAutoDubbed`, `isDefault`, `name` ("English (US)", "Japanese original").

const DUB_XTAG = "dubbed-auto"; // xtags "acont=dubbed-auto"; the original has "acont=original"

function decodeBase64Url(text: string): string {
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "===".slice((padded.length + 3) % 4));
  } catch {
    return "";
  }
}

/**
 * `true` for an auto-dubbed track, `false` for any other track, `null` when there is no track
 * object (no player yet). Reads `isAutoDubbed` wherever it sits; without it, the xtags in `id`.
 */
export function isAutoDubbed(track: unknown): boolean | null {
  if (typeof track !== "object" || track === null) return null;
  const record = track as Record<string, unknown>;
  if (typeof record.isAutoDubbed === "boolean") return record.isAutoDubbed;
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const flag = (value as Record<string, unknown>).isAutoDubbed;
      if (typeof flag === "boolean") return flag;
    }
  }
  const id = typeof record.id === "string" ? record.id : "";
  const xtags = id.includes(";") ? decodeBase64Url(id.slice(id.indexOf(";") + 1)) : "";
  return xtags.includes(DUB_XTAG);
}

interface AudioTrackPlayer {
  getAudioTrack?: () => unknown;
}

/** Whether `#movie_player` plays an auto-dubbed track now (`null`: cannot tell). */
export function playerPlaysDub(): boolean | null {
  const player = document.getElementById("movie_player") as AudioTrackPlayer | null;
  try {
    return isAutoDubbed(player?.getAudioTrack?.());
  } catch {
    return null;
  }
}
