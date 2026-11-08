// Helpers for YouTube URLs, shared by the page and content scripts.

/** Why there are no captions while YouTube plays an AI-dubbed audio track. */
export const DUB_REASON = "正在播放 AI 配音音軌，切回原始音軌才會產生";

/**
 * Why a page gets no captions at all, or "" when it does. Live streams have no end to
 * transcribe ahead of and would spend the day's budget in a few hours; Shorts use their
 * own player (`#shorts-player`, no CC menu, looping), which the content script does not
 * follow, and are short enough to read without. While the player plays an AI dub, the
 * viewer listens in their own language and Whisper would hear the dub: off until they
 * switch to the original track.
 */
export function unsupportedReason(pathname: string, live: boolean, dubbed = false): string {
  if (pathname.startsWith("/shorts/")) return "Shorts 不支援";
  if (live) return "直播不支援";
  if (dubbed) return DUB_REASON;
  return "";
}

/** The YouTube video ID in a watch, shorts, live or embed URL. */
export function videoIdFromUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const v = url.searchParams.get("v");
    if (v) return v;
    const match = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
