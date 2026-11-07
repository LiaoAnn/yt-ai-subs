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

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number]["value"];
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]["value"];

export interface Settings {
  groqApiKey: string;
  sourceLanguage: SourceLanguage;
  /** Off = transcribe-only mode. */
  translate: boolean;
  targetLanguage: TargetLanguage;
}

export const DEFAULT_SETTINGS: Settings = {
  groqApiKey: "",
  sourceLanguage: "ja",
  translate: true,
  targetLanguage: "zh-TW",
};

const STORAGE_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}
