// Page script: runs in YouTube's MAIN world at document_start, before the player code.
// Copies every audio segment YouTube appends to the main video's MediaSource buffers (never
// an ad's: see media-source-kind.ts) and hands it to the content script. YouTube buffers ahead of playback, so this yields
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
import { playerPlaysDub } from "./audio-track";
import { installCaptionTrack } from "./caption-hooks";
import { MediaSourceGate, lengthSecondsOf } from "./media-source-kind";
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

/** What the page script knows about one MediaSource that has an audio SourceBuffer. */
interface SourceState {
  /** Its object URL (what the <video> element's src is set to while it is attached). */
  url: string | null;
  gate: MediaSourceGate<SegmentMessage>;
  /** What the first append said about the audio track (logged once per MediaSource). */
  dubbed?: boolean | null;
}

/** `lengthSeconds` per video ID, from every player response the page got. */
const videoLengths = new Map<string, number>();

function observePlayerResponse(response: unknown) {
  const length = lengthSecondsOf(response);
  if (length) videoLengths.set(length.videoId, length.seconds);
}

function postSegment(message: SegmentMessage) {
  post(message, [message.bytes]);
}

const playerVideo = () => document.querySelector<HTMLVideoElement>("#movie_player video");

function install() {
  const audioBuffers = new WeakMap<SourceBuffer, AudioBufferInfo>();
  const bufferSource = new WeakMap<SourceBuffer, MediaSource>();
  const sourceUrls = new WeakMap<MediaSource, string>();
  const sources = new WeakMap<MediaSource, SourceState>();
  /** MediaSources still being classified (checked on a timer, e.g. for the hold timeout). */
  const pending = new Map<MediaSource, SourceState>();
  let nextId = 1;

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (this: typeof URL, object: Blob | MediaSource) {
    const url = createObjectURL.call(this, object);
    try {
      if (object instanceof MediaSource) sourceUrls.set(object, url);
    } catch {
      // a ManagedMediaSource-only browser: classification falls back below
    }
    return url;
  } as typeof URL.createObjectURL;

  /** Updates a pending MediaSource's classification; passes on what it held, if kept. */
  function classify(source: MediaSource, state: SourceState) {
    const { gate } = state;
    if (gate.kind !== "pending") return;
    const mainId = videoIdFromUrl(location.href);
    const mainLength = mainId ? (videoLengths.get(mainId) ?? null) : null;
    const release = gate.update({
      duration: source.duration,
      mainLength,
      // Attached = the player's <video> plays from it (unknown URL: while it is open).
      attached: state.url ? playerVideo()?.src === state.url : source.readyState !== "closed",
      adShowing: isAdShowing(),
      now: Date.now(),
    });
    if (gate.kind === "pending") return;
    console.log(
      LOG_PREFIX,
      `audio MediaSource: ${gate.kind} (duration ${source.duration}, video ${mainId} ` +
        `${mainLength ?? "?"} s, ${gate.settled.kept} of ` +
        `${gate.settled.kept + gate.settled.dropped} held segments kept)`,
    );
    for (const message of release) postSegment(message);
    pending.delete(source);
  }

  let timer: number | null = null;
  function watchPending() {
    if (timer !== null) return;
    timer = window.setInterval(() => {
      for (const [source, state] of pending) classify(source, state);
      if (pending.size === 0) {
        window.clearInterval(timer!);
        timer = null;
      }
    }, 100);
  }

  function hookMediaSource(mediaSource: typeof MediaSource | undefined) {
    const proto = mediaSource?.prototype as (MediaSource & { [HOOKED]?: true }) | undefined;
    if (!proto || proto[HOOKED]) return;
    proto[HOOKED] = true;
    const addSourceBuffer = proto.addSourceBuffer;
    proto.addSourceBuffer = function (this: MediaSource, mime: string) {
      const buffer = addSourceBuffer.call(this, mime);
      if (/^audio\//i.test(String(mime))) {
        audioBuffers.set(buffer, { id: nextId++, mime: String(mime) });
        bufferSource.set(buffer, this);
        if (!sources.has(this)) {
          const state: SourceState = {
            url: sourceUrls.get(this) ?? null,
            gate: new MediaSourceGate(Date.now()),
          };
          sources.set(this, state);
          pending.set(this, state);
          classify(this, state);
          watchPending();
        }
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
    const source = bufferSource.get(this);
    const state = source ? sources.get(source) : undefined;
    // An ad's MediaSource, or one whose segments are no longer wanted.
    if (!info || !source || !state || state.gate.kind === "ad")
      return appendBuffer.call(this, data);
    // An AI-dubbed track: none of its audio leaves the page (audio-track.ts). Switching the
    // track makes YouTube create a new MediaSource (8 of 8 switches on 4 videos) that starts
    // with init segments (2 of 2 inspected), so the original's audio comes complete after a
    // switch back.
    const dubbed = playerPlaysDub();
    if (state.dubbed === undefined || (dubbed === true) !== (state.dubbed === true)) {
      state.dubbed = dubbed;
      console.log(
        LOG_PREFIX,
        `audio track: ${dubbed ? "AI dub, not passed on" : dubbed === false ? "not a dub" : "unknown"}`,
      );
    }
    if (dubbed === true) return appendBuffer.call(this, data);

    const adShowing = isAdShowing();
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let before: Range[] | null = null;
    try {
      if (state.gate.kind !== "fallback" || !adShowing) {
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
          const message: SegmentMessage = {
            [PAGE_MESSAGE_TAG]: true,
            type: "segment",
            bufferId: info.id,
            mime: info.mime,
            videoId,
            init: isInitSegment(copy),
            start: span ? span[0] : null,
            end: span ? span[1] : null,
            bytes: copy.buffer,
          };
          classify(source, state);
          for (const kept of state.gate.offer(message, adShowing)) postSegment(kept);
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
  installCaptionTrack(observePlayerResponse);
}

console.log(LOG_PREFIX, "page script loaded (MAIN world)", document.readyState);
post({ [PAGE_MESSAGE_TAG]: true, type: "page-ready" });
