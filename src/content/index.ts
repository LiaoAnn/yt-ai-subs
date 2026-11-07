// Content script: runs in the isolated world at document_start.
// Next step: receive audio from the page script, cut it into chunks ahead of the
// playhead, schedule transcription via the background, and show the captions.
import { LOG_PREFIX } from "@/shared/log";
import { isPageMessage, type RuntimeMessage, type RuntimeReply } from "@/shared/messages";

console.log(LOG_PREFIX, "content script loaded (isolated world)", document.readyState);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isPageMessage(event.data)) return;
  console.log(LOG_PREFIX, "content script got page message:", event.data.type);
});

const ping: RuntimeMessage = { type: "ping" };
chrome.runtime.sendMessage<RuntimeMessage, RuntimeReply>(ping).then(
  (reply) => console.log(LOG_PREFIX, "background replied:", reply),
  (error: unknown) => console.warn(LOG_PREFIX, "background did not reply:", error),
);
