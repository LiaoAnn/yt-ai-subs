// What a video is about, from its player response: title, channel, description and tags.
// The translator gets the title and channel as context; Whisper gets none of it (see
// buildWhisperPrompt). Pure logic; the page script extracts the info and the content
// script builds the prompts.

export interface VideoInfo {
  videoId: string;
  title: string;
  channel: string;
  description: string;
  keywords: string[];
}

/** Caps for what the page script sends (the message comes from the page: untrusted). */
export const MAX_TITLE_CHARS = 300;
export const MAX_DESCRIPTION_CHARS = 5000;
export const MAX_KEYWORDS = 50;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** Title, channel, description and tags from a player response, or null. */
export function videoInfoFrom(response: unknown): VideoInfo | null {
  if (!isObject(response) || !isObject(response.videoDetails)) return null;
  const details = response.videoDetails;
  if (typeof details.videoId !== "string") return null;
  return {
    videoId: details.videoId,
    title: str(details.title, MAX_TITLE_CHARS),
    channel: str(details.author, MAX_TITLE_CHARS),
    description: str(details.shortDescription, MAX_DESCRIPTION_CHARS),
    keywords: Array.isArray(details.keywords)
      ? details.keywords
          .filter((k): k is string => typeof k === "string")
          .slice(0, MAX_KEYWORDS)
          .map((k) => k.slice(0, 100))
      : [],
  };
}

// ---------- Whisper's prompt ----------

/**
 * Whisper reads at most 224 prompt tokens and keeps the last ones. Budgets are in estimated
 * tokens (estimateWhisperTokens), kept under the limit with a margin.
 */
export const WHISPER_PROMPT_TOKENS = 200;
/**
 * Whisper reads at most 224 prompt tokens; the content script builds a prompt that fits
 * (buildWhisperPrompt, up to about 600 ASCII characters). The background sends at most the
 * last this many characters, which only caps what a message can make it send; the offline
 * evaluation (src/qa/) replays segmentation with the same prompt.
 */
export const WHISPER_PROMPT_CHARS = 3 * WHISPER_PROMPT_TOKENS + 100;

const WIDE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/u;

/**
 * Rough count of Whisper (byte-level BPE) tokens, on the high side: a kana, kanji or
 * Hangul syllable is one or two tokens, Latin text about one per three characters.
 */
export function estimateWhisperTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += charTokens(char);
  return Math.ceil(tokens);
}

const charTokens = (char: string) => (char.charCodeAt(0) < 128 ? 1 / 3 : WIDE.test(char) ? 1.5 : 1);

/** Keeps the end of `text` that fits in `budget` estimated tokens, from a word start. */
export function tailWithin(text: string, budget: number): string {
  const chars = [...text];
  let tokens = 0;
  let start = chars.length;
  while (start > 0) {
    const next = tokens + charTokens(chars[start - 1]!);
    if (next > budget) break;
    tokens = next;
    start--;
  }
  if (start === 0) return text;
  let tail = chars.slice(start).join("");
  // Do not begin in the middle of a word when the text has spaces.
  const space = tail.indexOf(" ");
  if (space >= 0 && space < tail.length / 2) tail = tail.slice(space + 1);
  return tail.trim();
}

/**
 * Whisper's prompt: the most recent captions only, never the video's title, channel,
 * description or tags. With them at the front (PR #9), Whisper decoded garbage on some
 * videos ("テレレレレレレレ.", "衆印印印印…"; on cth3M1iavGM 79 characters of captions over
 * 180 s instead of 774, on dZgXCAWnz2c 17 instead of 997) and spelled names no better.
 * The video info goes to the translator instead.
 */
export function buildWhisperPrompt(recent: string, budget = WHISPER_PROMPT_TOKENS): string {
  const text = recent.trim();
  return text ? tailWithin(text, budget) : "";
}
