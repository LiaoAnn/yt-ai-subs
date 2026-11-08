// Helpers for YouTube URLs, shared by the page and content scripts.

/**
 * Why a page gets no captions at all, or "" when it does. Live streams have no end to
 * transcribe ahead of and would spend the day's budget in a few hours; Shorts use their
 * own player (`#shorts-player`, no CC menu, looping), which the content script does not
 * follow, and are short enough to read without.
 */
export function unsupportedReason(pathname: string, live: boolean): string {
  if (pathname.startsWith("/shorts/")) return "Shorts 不支援";
  if (live) return "直播不支援";
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
