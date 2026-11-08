// What a video is about, from its player response: title, channel, description and tags.
// Whisper gets the names and terms in its prompt (so it spells them right), and the
// translator gets the title and channel as context. Pure logic; the page script extracts
// the info and the content script builds the prompt.

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
 * Whisper reads at most 224 prompt tokens and keeps the last ones, so the video's terms go
 * first and the recent captions (the most useful part) last. Budgets are in estimated
 * tokens (estimateWhisperTokens), kept under the limit with a margin.
 */
export const WHISPER_PROMPT_TOKENS = 200;
/** At most this much of the prompt goes to the video's title, channel and terms. */
export const VIDEO_TERMS_TOKENS = 80;
const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 20;
const MAX_TITLE_PROMPT_CHARS = 60;

const WIDE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/u;

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

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
/** Lines in a description that list who appears: "출연: 유재석, 지석진". */
const CAST_LINE =
  /(?:출연|게스트|진행|패널|\bMC\b|\bcast\b|\bguests?\b|\bhosts?\b|出演|ゲスト|司会|メンバー)[\s\]】)）」』]*[:：|]?\s*(.*)$/iu;
const LIST_SEPARATOR = /[,，、/／·・|｜&＆\n]+|\s{2,}/u;

const clean = (text: string) =>
  text.replace(URL_PATTERN, " ").replace(EMOJI, "").replace(/\s+/g, " ").trim();

/** Subtitle and episode notes in a title's brackets: 〈字幕：English・簡体〉, [ENG SUB]. */
const TITLE_NOTE = /字幕|자막|\bsub|\bcc\b|\beng\b|english|繁体|簡体|简体|繁體|中文|日本語|한국어/i;

/**
 * The title without hashtags, emoji, and bracketed notes: pure-ASCII tags like [ENG SUB]
 * or (EP.12), and subtitle notes like 〈字幕：English・簡体〉. Whisper repeats such notes
 * over music ("〈字幕〉") when they are in its prompt.
 */
export function cleanTitle(title: string): string {
  const text = clean(title.replace(HASHTAG, " "))
    .replace(/[[(（【「『〈《<]([^\])）】」』〉》>]*)[\])）】」』〉》>]/g, (match, inner: string) =>
      (/^[\x20-\x7e]*$/.test(inner) && /[a-z]/i.test(inner)) || TITLE_NOTE.test(inner)
        ? " "
        : match,
    )
    .replace(/\s+/g, " ")
    .trim();
  return [...text].slice(0, MAX_TITLE_PROMPT_CHARS).join("");
}

/** A term from a list item: no parenthesised romanisation, no @, sensible length. */
function term(raw: string): string | null {
  const text = clean(raw)
    .replace(/[(（][^)）]*[)）]/g, " ")
    .replace(/^[@#\-–—*•·\s]+|[\s.:：!！?？]+$/gu, "")
    .trim();
  const length = [...text].length;
  if (length < MIN_TERM_CHARS || length > MAX_TERM_CHARS) return null;
  if (/^[\p{N}\p{P}\s]+$/u.test(text)) return null; // dates, numbers, punctuation
  return text;
}

/** Letters of the source language's script, or null to accept every script. */
function sourceScript(language: string): RegExp | null {
  if (language === "ko") return /[가-힯ᄀ-ᇿ㄰-㆏]/u;
  if (language === "ja") return /[぀-ヿ㐀-鿿]/u;
  if (language === "zh") return /[㐀-鿿]/u;
  return null;
}

/**
 * Names and terms worth spelling for Whisper, most useful first: people listed as cast in
 * the description, hashtags, then the video's tags. Terms already in the title or channel
 * are left out, and so are tags not written in the source language's script (mostly
 * search keywords in other languages).
 */
export function videoTerms(info: VideoInfo, sourceLanguage = "auto"): string[] {
  const cast: string[] = [];
  const hashtags: string[] = [];
  for (const line of info.description.replace(URL_PATTERN, " ").split("\n")) {
    const match = CAST_LINE.exec(line);
    if (match?.[1]) cast.push(...match[1].split(LIST_SEPARATOR));
  }
  for (const match of `${info.title}\n${info.description}`.matchAll(HASHTAG)) {
    hashtags.push(match[1]!.replace(/_/g, " "));
  }
  const script = sourceScript(sourceLanguage);
  const keywords = info.keywords.filter((k) => !script || script.test(k));

  const title = cleanTitle(info.title).toLowerCase().replace(/\s+/g, "");
  const channel = info.channel.toLowerCase().replace(/\s+/g, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...cast, ...hashtags, ...keywords]) {
    const text = term(raw);
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key) || title.includes(key) || channel.includes(key)) continue;
    seen.add(key);
    out.push(text);
  }
  // Within each group the order stays; terms in the source script come first overall.
  return script
    ? [...out.filter((t) => script.test(t)), ...out.filter((t) => !script.test(t))]
    : out;
}

/** The video part of Whisper's prompt: "title. channel. term, term, …", within `budget`. */
export function videoPromptPart(
  info: VideoInfo | null | undefined,
  sourceLanguage = "auto",
  budget = VIDEO_TERMS_TOKENS,
): string {
  if (!info) return "";
  const parts = [cleanTitle(info.title), clean(info.channel)].filter(Boolean);
  let text = parts.join(". ");
  if (estimateWhisperTokens(text) > budget) {
    text = clean(info.channel);
    if (estimateWhisperTokens(text) > budget) return "";
  }
  const terms: string[] = [];
  for (const t of videoTerms(info, sourceLanguage)) {
    const next = `${text}. ${[...terms, t].join(", ")}`;
    if (estimateWhisperTokens(`${next}.`) > budget) break;
    terms.push(t);
  }
  if (terms.length) text = `${text}. ${terms.join(", ")}`;
  return text ? `${text}.` : "";
}

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
 * Whisper's prompt: the video's title, channel and terms, then the most recent captions.
 * The recent captions keep at least the budget the video part leaves unused.
 */
export function buildWhisperPrompt(
  info: VideoInfo | null | undefined,
  recent: string,
  sourceLanguage = "auto",
  budget = WHISPER_PROMPT_TOKENS,
): string {
  const video = videoPromptPart(info, sourceLanguage, Math.min(VIDEO_TERMS_TOKENS, budget));
  const rest = budget - (video ? estimateWhisperTokens(video) + 1 : 0);
  const tail = recent.trim() ? tailWithin(recent.trim(), rest) : "";
  return [video, tail].filter(Boolean).join(" ");
}
