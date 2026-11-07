// Page script: runs in YouTube's MAIN world at document_start, before the player code.
// Next step: hook SourceBuffer.prototype.appendBuffer here and copy the audio YouTube
// appends, then hand it to the content script with window.postMessage.
// Bundled as one classic script (IIFE): keep it free of globals and chrome.* APIs.
import { LOG_PREFIX } from "@/shared/log";
import { PAGE_MESSAGE_TAG, type PageMessage } from "@/shared/messages";

console.log(LOG_PREFIX, "page script loaded (MAIN world)", document.readyState);

const ready: PageMessage = { [PAGE_MESSAGE_TAG]: true, type: "page-ready" };
window.postMessage(ready, location.origin);
