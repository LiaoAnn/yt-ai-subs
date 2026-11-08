// Groq API calls: Whisper speech-to-text and gpt-oss translation. Every request goes
// through the shared rate limiter. Never log the API key or request headers.

import type { Cue } from "@/shared/captions";
import { parseReplyTerms } from "@/shared/glossary";
import { WHISPER_PROMPT_TOKENS } from "@/shared/video-context";
import { LOG_PREFIX } from "@/shared/log";
import type { Settings } from "@/shared/settings";
import { TARGET_LANGUAGES } from "@/shared/settings";
import {
  MIN_BILLED_AUDIO_SECONDS,
  acquire,
  type Cost,
  type RateLimiter,
  type RequestKind,
} from "./rate-limiter";
import { whisperToCues, type WhisperVerboseJson } from "./segmentation";

const TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
/** Retries after a 429, each one waiting for retry-after first. */
const MAX_429_RETRIES = 2;
/**
 * Whisper reads at most 224 prompt tokens; the content script builds a prompt that fits
 * (buildWhisperPrompt, up to about 600 ASCII characters). This only caps what a message
 * can make us send, above anything buildWhisperPrompt returns.
 */
export const WHISPER_PROMPT_CHARS = 3 * WHISPER_PROMPT_TOKENS + 100;
const MAX_COMPLETION_TOKENS = 2048;

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export interface CallStats {
  /** Time from sending the request to the response headers, without rate-limit waiting. */
  latencyMs: number;
  /** Time spent waiting for the rate limiter. */
  waitedMs: number;
}

/** fetch() through the limiter, retrying 429s after Groq's retry-after. */
async function limitedFetch(
  limiter: RateLimiter,
  kind: RequestKind,
  cost: Cost,
  makeRequest: () => { url: string; init: RequestInit },
  signal: AbortSignal,
  onLimiterChange: () => void,
): Promise<{ response: Response; entryId: number; stats: CallStats }> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const slot = await acquire(limiter, kind, cost, signal);
    waitedMs += slot.waitedMs;
    onLimiterChange();
    const { url, init } = makeRequest();
    const sent = Date.now();
    const response = await fetch(url, { ...init, signal });
    limiter.noteHeaders(kind, response.headers, Date.now());
    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      const blockedMs = limiter.noteTooManyRequests(kind, response.headers, Date.now());
      onLimiterChange();
      console.warn(
        LOG_PREFIX,
        `Groq 429 on ${kind}; retrying in ${Math.round(blockedMs / 1000)} s`,
      );
      await response.body?.cancel();
      continue;
    }
    onLimiterChange();
    return { response, entryId: slot.id, stats: { latencyMs: Date.now() - sent, waitedMs } };
  }
}

async function errorFrom(response: Response, what: string): Promise<GroqError> {
  let detail = "";
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    detail = json.error?.message ?? "";
  } catch {
    // not JSON; the status is enough
  }
  return new GroqError(
    `${what} ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    response.status,
  );
}

export interface TranscribeResult {
  cues: Cue[];
  language: string;
  stats: CallStats;
  raw: WhisperVerboseJson;
}

export async function transcribe(
  limiter: RateLimiter,
  settings: Settings,
  wav: Uint8Array<ArrayBuffer>,
  durationSeconds: number,
  context: string,
  signal: AbortSignal,
  onLimiterChange: () => void,
  onBilled: (cost: Cost) => void = () => {},
): Promise<TranscribeResult> {
  const cost: Cost = {
    requests: 1,
    audioSeconds: Math.max(MIN_BILLED_AUDIO_SECONDS, durationSeconds),
  };
  const prompt = context.slice(-WHISPER_PROMPT_CHARS);
  const { response, stats } = await limitedFetch(
    limiter,
    "whisper",
    cost,
    () => {
      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
      form.append("model", settings.whisperModel);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
      form.append("temperature", "0");
      if (settings.sourceLanguage !== "auto") form.append("language", settings.sourceLanguage);
      if (prompt) form.append("prompt", prompt);
      return {
        url: TRANSCRIBE_URL,
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.groqApiKey}` },
          body: form,
        },
      };
    },
    signal,
    onLimiterChange,
  );
  if (!response.ok) throw await errorFrom(response, "語音辨識失敗");
  onBilled(cost);
  const json = (await response.json()) as WhisperVerboseJson;
  return { cues: whisperToCues(json, prompt), language: json.language ?? "", stats, raw: json };
}

export interface TranslateResult {
  lines: string[];
  totalTokens: number;
  /** Names and terms the model says it translated (source -> translation), unchecked. */
  terms: Record<string, unknown>;
  stats: CallStats;
}

export interface TranslateExtras {
  /** The video's title and channel. */
  video?: { title: string; channel: string };
  /** Renderings already used in this video: (source, translation). */
  glossary?: readonly (readonly [string, string])[];
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The user message: video, glossary, context, then the numbered lines. */
export function translationUserMessage(
  lines: readonly string[],
  context: string,
  extras: TranslateExtras = {},
): string {
  const parts: string[] = [];
  const title = oneLine(extras.video?.title ?? "", 150);
  const channel = oneLine(extras.video?.channel ?? "", 80);
  if (title || channel) {
    parts.push(
      `Video: ${[title && `"${title}"`, channel && `channel ${channel}`].filter(Boolean).join(", ")}`,
    );
  }
  const glossary = (extras.glossary ?? []).filter(([a, b]) => a.trim() && b.trim()).slice(0, 30);
  if (glossary.length) {
    parts.push(
      `Glossary (renderings already used in this video; use them again):\n` +
        glossary.map(([a, b]) => `${oneLine(a, 30)} → ${oneLine(b, 30)}`).join("\n"),
    );
  }
  if (context) parts.push(`Previous lines (original → translation), for context only:\n${context}`);
  parts.push(`Lines to translate (${lines.length}):\n${JSON.stringify(numberLines(lines))}`);
  return parts.join("\n\n");
}

function targetLanguageName(settings: Settings): string {
  if (settings.targetLanguage === "zh-TW") {
    return "Traditional Chinese as used in Taiwan (繁體中文，台灣用語)";
  }
  return (
    TARGET_LANGUAGES.find((language) => language.value === settings.targetLanguage)?.label ??
    settings.targetLanguage
  );
}

/** Rough token estimate for the limiter before the real usage is known. */
export function estimateChatTokens(promptChars: number, lineCount: number): number {
  // CJK text runs about one token per character; output and low-effort reasoning add a
  // few hundred more. The entry is corrected with usage.total_tokens afterwards.
  return Math.ceil(promptChars * 1.1) + lineCount * 40 + 400;
}

/** Numbers lines from 1, as the JSON object the model sees: {"1": "...", "2": "..."}. */
export function numberLines(lines: readonly string[]): Record<string, string> {
  return Object.fromEntries(lines.map((line, i) => [String(i + 1), line]));
}

/**
 * Pulls the translations out of the model's JSON reply, by line number, so a merged or
 * skipped line cannot shift the others. Missing lines come back as undefined; returns null
 * if the reply is unusable. Also accepts a plain array under "t" or "lines".
 */
export function parseTranslatedLines(text: string, count: number): (string | undefined)[] | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  const list = Array.isArray(record.t)
    ? record.t
    : Array.isArray(record.lines)
      ? record.lines
      : null;
  const source: Record<string, unknown> = list ? numberLines(list.map(String)) : record;
  const out = Array.from({ length: count }, (_, i) => {
    const value = source[String(i + 1)];
    return typeof value === "string" && value.trim() ? value : undefined;
  });
  return out.some((line) => line !== undefined) ? out : null;
}

export async function translate(
  limiter: RateLimiter,
  settings: Settings,
  lines: string[],
  context: string,
  signal: AbortSignal,
  onLimiterChange: () => void,
  onBilled: (cost: Cost) => void = () => {},
  extras: TranslateExtras = {},
): Promise<TranslateResult> {
  const system = `You are a professional subtitle translator. Translate subtitle lines into ${targetLanguageName(settings)}.
The input is a JSON object of numbered lines, consecutive pieces of speech from a video.
- The text comes from speech recognition and has mistakes: similar-sounding wrong words, garbled bits. Work out what was most likely said from the context and translate that.
- A line is often only part of a sentence that continues on the next line: translate it as the matching part of that sentence, so the lines read naturally in order.
- Every key's value translates that same key's line and nothing else: never move words to another key, never merge, skip or split lines, even when lines repeat.
- Translate idioms and slang by meaning, not word for word.
- Write natural, concise subtitles in the spoken style of the target language${settings.targetLanguage === "zh-TW" ? " as used in Taiwan (Taiwanese vocabulary, no Mainland terms)" : ""}. Leave out pure fillers (えっと, あの, まあ, 그, 뭐, um); a line that is only a filler gets a short natural interjection.
- Use the established names of well-known people, groups and companies in the target language when you know them, and keep every name the same throughout. The video's title and channel help to tell who is speaking and what the names are.
- Never leave Hangul or Japanese kana in the translation, not even in a name. ${settings.targetLanguage === "en" ? "Romanise Korean and Japanese names (지수 → Jisoo, はると → Haruto)." : "Write Korean and Japanese names in Chinese characters: the person's established Chinese name if there is one, else a usual transliteration (지수 → 智秀, 민준 → 珉俊, はると → 陽翔); leave out honorifics like 님 and さん or translate them."}
- When a glossary is given, translate each of its terms exactly as it says.
- Keep a line that is already in the target language.
Reply ONLY with a JSON object with exactly the same numbered keys, plus "terms": {"1": "...", "2": "...", ..., "terms": {...}}.
"terms" maps each name of a person, group, show or place, and each recurring special term, in these lines (written exactly as in the line, without particles or endings) to how you translated it. Ordinary words are not terms. Use {} when there are none.`;
  const user = translationUserMessage(lines, context, extras);
  const estimate = estimateChatTokens(system.length + user.length, lines.length);
  const { response, entryId, stats } = await limitedFetch(
    limiter,
    "chat",
    { requests: 1, tokens: estimate },
    () => ({
      url: CHAT_URL,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.groqApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.translationModel,
          temperature: 0.2,
          reasoning_effort: "low",
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      },
    }),
    signal,
    onLimiterChange,
  );
  if (!response.ok) throw await errorFrom(response, "翻譯失敗");
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { total_tokens?: number };
  };
  const totalTokens = Number(json.usage?.total_tokens) || estimate;
  limiter.adjust("chat", entryId, { tokens: totalTokens });
  onLimiterChange();
  onBilled({ requests: 1, tokens: totalTokens });
  console.log(
    LOG_PREFIX,
    `translation: ${lines.length} lines, ${totalTokens} tokens, ${stats.latencyMs} ms`,
  );
  const content = json.choices?.[0]?.message?.content ?? "";
  const translated = parseTranslatedLines(content, lines.length);
  if (!translated) throw new GroqError("翻譯格式看不懂");
  return {
    lines: lines.map((line, i) => translated[i] ?? line),
    totalTokens,
    terms: parseReplyTerms(content) ?? {},
    stats,
  };
}
