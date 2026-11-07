// Background service worker (ES module).
// Next step: call Groq speech-to-text and translation here, keeping under the free-tier
// rate limits listed in AGENTS.md.
import { LOG_PREFIX } from "@/shared/log";
import type { RuntimeMessage, RuntimeReply } from "@/shared/messages";

console.log(LOG_PREFIX, "background service worker loaded");

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message.type === "ping") {
    console.log(LOG_PREFIX, "ping from tab", sender.tab?.id);
    const reply: RuntimeReply = { type: "pong", version: chrome.runtime.getManifest().version };
    sendResponse(reply);
  }
  return false;
});
