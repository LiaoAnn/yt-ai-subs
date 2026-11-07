// Messages between the extension's contexts.
//
// page script (MAIN world) --window.postMessage--> content script (isolated world)
// content script --chrome.runtime.sendMessage--> background service worker

/** Tag on every window message, so the content script ignores YouTube's own messages. */
export const PAGE_MESSAGE_TAG = "__ytAiSubs";

const PAGE_MESSAGE_TYPES = ["page-ready"] as const;

export type PageMessage = {
  [PAGE_MESSAGE_TAG]: true;
  type: (typeof PAGE_MESSAGE_TYPES)[number];
};

/**
 * Checks the shape of a window message. Any script on the page can post one that passes,
 * so treat the payload as untrusted input even when this returns true.
 */
export function isPageMessage(data: unknown): data is PageMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message[PAGE_MESSAGE_TAG] === true &&
    (PAGE_MESSAGE_TYPES as readonly unknown[]).includes(message.type)
  );
}

export type RuntimeMessage = { type: "ping" };
export type RuntimeReply = { type: "pong"; version: string };
