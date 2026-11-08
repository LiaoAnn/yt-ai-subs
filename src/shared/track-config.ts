// What the page script needs to know, synchronously, when it adds the AI caption track to
// a player response: whether the extension is on, the track's name and its language.
//
// The page script runs in the MAIN world and cannot read chrome.storage, and the first
// player response is assigned while the HTML is still parsing, before the content script
// could answer a message. So the content script mirrors these (non-secret) fields into the
// page's localStorage, and the page script reads them from there.

import type { Settings } from "./settings";

export const TRACK_CONFIG_STORAGE_KEY = "yt-ai-subs:track";

export interface TrackConfig {
  enabled: boolean;
  /** Name shown in YouTube's caption menu. */
  label: string;
  /** BCP-47 code of the track's main text. */
  languageCode: string;
  /** The track is a translation (else it shows the spoken language). */
  translate: boolean;
  /** The spoken language setting ("auto" or a code), to find the creator's own track. */
  sourceLanguage: string;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
  enabled: true,
  label: "AI 繁中",
  languageCode: "zh-TW",
  translate: true,
  sourceLanguage: "ja",
};

const TARGET_LABELS: Record<string, string> = { "zh-TW": "AI 繁中", en: "AI 英文" };

export function trackConfigFromSettings(settings: Settings): TrackConfig {
  if (settings.translate) {
    return {
      enabled: settings.enabled,
      label: TARGET_LABELS[settings.targetLanguage] ?? "AI 翻譯",
      languageCode: settings.targetLanguage,
      translate: true,
      sourceLanguage: settings.sourceLanguage,
    };
  }
  return {
    enabled: settings.enabled,
    label: "AI 原文",
    languageCode: settings.sourceLanguage === "auto" ? "und" : settings.sourceLanguage,
    translate: false,
    sourceLanguage: settings.sourceLanguage,
  };
}

/** Parses the mirrored config; anything missing or malformed falls back to the default. */
export function parseTrackConfig(raw: string | null): TrackConfig {
  if (!raw) return DEFAULT_TRACK_CONFIG;
  try {
    const value = JSON.parse(raw) as Partial<TrackConfig> | null;
    if (typeof value !== "object" || value === null) return DEFAULT_TRACK_CONFIG;
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_TRACK_CONFIG.enabled,
      label:
        typeof value.label === "string" && value.label.trim()
          ? value.label.slice(0, 40)
          : DEFAULT_TRACK_CONFIG.label,
      languageCode:
        typeof value.languageCode === "string" &&
        /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value.languageCode)
          ? value.languageCode
          : DEFAULT_TRACK_CONFIG.languageCode,
      translate:
        typeof value.translate === "boolean" ? value.translate : DEFAULT_TRACK_CONFIG.translate,
      sourceLanguage:
        typeof value.sourceLanguage === "string" &&
        /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(value.sourceLanguage)
          ? value.sourceLanguage
          : DEFAULT_TRACK_CONFIG.sourceLanguage,
    };
  } catch {
    return DEFAULT_TRACK_CONFIG;
  }
}
