// Helpers for YouTube URLs, shared by the page and content scripts.

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
