// Content-script side of the AI caption track in YouTube's caption (CC) menu: mirrors the
// track config into localStorage, sends the cues to the page script, and keeps the page
// script's verdict on whether the track works (else the overlay is used).

import { toJson3, type Cue, type TrackText } from "@/shared/captions";
import { LOG_PREFIX } from "@/shared/log";
import {
  PAGE_COMMAND_TAG,
  type CaptionModeMessage,
  type DisplayModeReply,
  type TrackCuesCommand,
} from "@/shared/messages";
import type { Settings } from "@/shared/settings";
import { TRACK_CONFIG_STORAGE_KEY, trackConfigFromSettings } from "@/shared/track-config";
import { unsupportedReason } from "@/shared/youtube";

/** Without any word from the page script about a video this long, use the overlay. */
const SILENT_PAGE_MS = 10_000;

export function trackText(settings: Settings): TrackText {
  if (!settings.translate) return "original";
  return settings.showOriginal ? "both" : "translation";
}

/** What decides the track's events; when it is unchanged, nothing needs sending. */
function syncKey(videoId: string, version: number, settings: Settings): string {
  return `${videoId}\n${version}\n${settings.enabled ? trackText(settings) : "off"}`;
}

export class CaptionTrackBridge {
  private lastSent = "";
  private verdict: CaptionModeMessage | null = null;
  /** When the last verdict arrived (ms). */
  private verdictAt = 0;
  /** The video in the URL and when this script first asked about it. */
  private seen: { videoId: string; at: number } | null = null;

  /** Mirrors what the page script needs before the content script can talk to it. */
  writeConfig(settings: Settings): void {
    try {
      localStorage.setItem(
        TRACK_CONFIG_STORAGE_KEY,
        JSON.stringify(trackConfigFromSettings(settings)),
      );
    } catch (error) {
      console.warn(LOG_PREFIX, "could not store the caption track config", error);
    }
  }

  /**
   * Sends the video's cues to the page script when they changed: when `version` (bumped by
   * the caller on every change to the cues) or a setting that shapes the text differs from
   * the last call. Cheap when nothing changed, however long the video.
   */
  sync(videoId: string, version: number, cues: readonly Cue[], settings: Settings): void {
    const key = syncKey(videoId, version, settings);
    if (key === this.lastSent) return;
    this.lastSent = key;
    const events = settings.enabled ? toJson3(cues, trackText(settings)).events : [];
    const command: TrackCuesCommand = {
      [PAGE_COMMAND_TAG]: true,
      type: "track-cues",
      videoId,
      events,
    };
    window.postMessage(command, location.origin);
  }

  onVerdict(message: CaptionModeMessage, now = Date.now()): void {
    const previous = this.verdict;
    this.verdict = message;
    this.verdictAt = now;
    if (
      message.mode !== previous?.mode ||
      message.videoId !== previous?.videoId ||
      message.reason !== previous?.reason
    ) {
      console.log(
        LOG_PREFIX,
        `display mode for ${message.videoId}: ${message.mode}` +
          (message.reason ? ` (${message.reason})` : ""),
      );
    }
  }

  /** Whether the page script saw `videoId`'s player response say it is a live stream. */
  isLive(videoId: string | null): boolean {
    return videoId !== null && this.verdict?.videoId === videoId && this.verdict.live === true;
  }

  /**
   * Whether a verdict arrived at or after `since` (ms). The page script posts one when the
   * <video>'s source changes ("emptied", e.g. an audio-track switch); until it arrives, the
   * dub verdict may be stale.
   */
  heardSince(since: number): boolean {
    return this.verdict !== null && this.verdictAt >= since;
  }

  /**
   * Why `videoId` (the video in the URL, on a page at `pathname`) gets no captions now (a
   * Short, a live stream, an AI dub playing), or "".
   */
  offReason(videoId: string | null, pathname: string): string {
    return unsupportedReason(pathname, this.isLive(videoId), this.isDubbed(videoId));
  }

  /** Whether the page script last said the player plays an AI dub for `videoId`. */
  isDubbed(videoId: string | null): boolean {
    return videoId !== null && this.verdict?.videoId === videoId && this.verdict.dubbed === true;
  }

  /** The mode for `videoId` (the video in the URL). */
  mode(videoId: string | null, now = Date.now()): DisplayModeReply {
    if (!videoId) return { videoId, mode: "pending", reason: "" };
    if (this.seen?.videoId !== videoId) this.seen = { videoId, at: now };
    if (this.verdict && this.verdict.videoId === videoId) {
      return { videoId, mode: this.verdict.mode, reason: this.verdict.reason };
    }
    if (now - this.seen.at >= SILENT_PAGE_MS) {
      return { videoId, mode: "overlay", reason: "頁面腳本沒有回報字幕軌狀態" };
    }
    return { videoId, mode: "pending", reason: "" };
  }
}
