// Page script: runs in YouTube's MAIN world at document_start, before the player code.
// Copies every audio segment YouTube appends to its MediaSource buffers (never during ads)
// and hands it to the content script. YouTube buffers ahead of playback, so this yields
// future audio without downloading anything extra. It also serves the AI captions as a
// track in YouTube's own caption (CC) menu (caption-hooks.ts).
// Bundled as one classic script (IIFE): keep it free of globals and chrome.* APIs.
import { LOG_PREFIX } from "@/shared/log";
import {
  PAGE_MESSAGE_TAG,
  type AudioBufferMessage,
  type PageReadyMessage,
  type SegmentMessage,
} from "@/shared/messages";
import { videoIdFromUrl } from "@/shared/youtube";
import { installCaptionTrack } from "./caption-hooks";
import { newSpan, type Range } from "./ranges";

const HOOKED = Symbol.for("yt-ai-subs.hooked");

interface AudioBufferInfo {
  id: number;
  mime: string;
}

function post(
  message: PageReadyMessage | AudioBufferMessage | SegmentMessage,
  transfer?: Transferable[],
) {
  window.postMessage(message, { targetOrigin: location.origin, transfer });
}

const ranges = (buffered: TimeRanges): Range[] => {
  const out: Range[] = [];
  for (let i = 0; i < buffered.length; i++) out.push([buffered.start(i), buffered.end(i)]);
  return out;
};

const isAdShowing = () =>
  document.getElementById("movie_player")?.classList.contains("ad-showing") ?? false;

function copyBytes(data: BufferSource): Uint8Array<ArrayBuffer> | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy;
  }
  return null;
}

function isInitSegment(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70; // 'ftyp'
}

function install() {
  const audioBuffers = new WeakMap<SourceBuffer, AudioBufferInfo>();
  let nextId = 1;

  function hookMediaSource(source: typeof MediaSource | undefined) {
    const proto = source?.prototype as (MediaSource & { [HOOKED]?: true }) | undefined;
    if (!proto || proto[HOOKED]) return;
    proto[HOOKED] = true;
    const addSourceBuffer = proto.addSourceBuffer;
    proto.addSourceBuffer = function (this: MediaSource, mime: string) {
      const buffer = addSourceBuffer.call(this, mime);
      if (/^audio\//i.test(String(mime))) {
        audioBuffers.set(buffer, { id: nextId++, mime: String(mime) });
        post({ [PAGE_MESSAGE_TAG]: true, type: "audio-buffer", mime: String(mime) });
      }
      return buffer;
    };
  }
  hookMediaSource(window.MediaSource);
  hookMediaSource((window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource);

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    const info = audioBuffers.get(this);
    if (!info) return appendBuffer.call(this, data);

    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let before: Range[] | null = null;
    try {
      if (!isAdShowing()) {
        bytes = copyBytes(data);
        before = ranges(this.buffered);
      }
    } catch {
      bytes = null;
    }

    const result = appendBuffer.call(this, data); // if this throws, no listener is added
    if (bytes && before) {
      const copy = bytes;
      const previous = before;
      const videoId = videoIdFromUrl(location.href);
      this.addEventListener(
        "updateend",
        () => {
          let span: Range | null = null;
          try {
            span = newSpan(ranges(this.buffered), previous);
          } catch {
            // the buffer was removed from its MediaSource
          }
          post(
            {
              [PAGE_MESSAGE_TAG]: true,
              type: "segment",
              bufferId: info.id,
              mime: info.mime,
              videoId,
              init: isInitSegment(copy),
              start: span ? span[0] : null,
              end: span ? span[1] : null,
              bytes: copy.buffer,
            },
            [copy.buffer],
          );
        },
        { once: true },
      );
    }
    return result;
  };
}

const flags = window as unknown as { [HOOKED]?: true };
if (!flags[HOOKED]) {
  flags[HOOKED] = true;
  install();
  installCaptionTrack();
}

console.log(LOG_PREFIX, "page script loaded (MAIN world)", document.readyState);
post({ [PAGE_MESSAGE_TAG]: true, type: "page-ready" });
