// User settings, stored in chrome.storage.local (never synced: it holds the API key).

export const SOURCE_LANGUAGES = [
  { value: "auto", label: "自動偵測" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韓文" },
  { value: "en", label: "英文" },
] as const;

export const TARGET_LANGUAGES = [
  { value: "zh-TW", label: "繁體中文（台灣）" },
  { value: "en", label: "英文" },
] as const;

export const WHISPER_MODELS = [
  { value: "whisper-large-v3", label: "whisper-large-v3（較準）" },
  { value: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo（較快）" },
] as const;

export const TRANSLATION_MODELS = [
  { value: "openai/gpt-oss-120b", label: "gpt-oss-120b（較好）" },
  { value: "openai/gpt-oss-20b", label: "gpt-oss-20b（較快）" },
] as const;

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number]["value"];
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]["value"];
export type WhisperModel = (typeof WHISPER_MODELS)[number]["value"];
export type TranslationModel = (typeof TRANSLATION_MODELS)[number]["value"];

export interface Settings {
  /** Off = the content script does nothing (no audio is sent anywhere). */
  enabled: boolean;
  groqApiKey: string;
  whisperModel: WhisperModel;
  sourceLanguage: SourceLanguage;
  /** Off = transcribe-only mode. */
  translate: boolean;
  targetLanguage: TargetLanguage;
  translationModel: TranslationModel;
  /** Show the original line above the translation. */
  showOriginal: boolean;
  /**
   * Development only, not in the popup: keep each chunk's raw Whisper response, loudness
   * envelope and cues in chrome.storage.local (`debug:*`) for offline evaluation.
   */
  debugCapture: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  groqApiKey: "",
  whisperModel: "whisper-large-v3",
  sourceLanguage: "ja",
  translate: true,
  targetLanguage: "zh-TW",
  translationModel: "openai/gpt-oss-120b",
  showOriginal: true,
  debugCapture: false,
};

export const SETTINGS_STORAGE_KEY = "settings";

/** Merges stored (possibly older or partial) settings over the defaults. */
export function withDefaults(stored: unknown): Settings {
  const partial =
    typeof stored === "object" && stored !== null ? (stored as Partial<Settings>) : {};
  return { ...DEFAULT_SETTINGS, ...partial };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return withDefaults(stored[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}
