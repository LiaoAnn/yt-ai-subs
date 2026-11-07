// Turns a Whisper verbose_json response into subtitle lines: drops hallucinations, uses
// word timestamps for timing, splits long segments, and pads lines for readability.
// Times here are seconds relative to the start of the audio chunk.

import type { Cue } from "@/shared/captions";

export interface WhisperWord {
  word?: string;
  text?: string;
  start: number;
  end: number;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export interface WhisperVerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  words?: WhisperWord[];
}

interface Word {
  text: string;
  start: number;
  end: number;
}

/** Phrases Whisper tends to "hear" in silence or music. */
const HALLUCINATIONS: readonly RegExp[] = [
  /ご視聴ありがとうございました/,
  /チャンネル登録/,
  /お疲れ様でした。?$/,
  /^(\s*[.…。]+\s*)$/,
  /시청해\s*주셔서\s*감사합니다/,
  /구독과\s*좋아요/,
  /^字幕/,
  /Thank you for watching/i,
  /請不吝點贊/,
];

export function isHallucination(text: string): boolean {
  return HALLUCINATIONS.some((pattern) => pattern.test(text));
}

/** Scripts written without spaces between words (kana, kanji, full-width forms). */
const NO_SPACE_SCRIPT = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
const HANGUL = /[\uac00-\ud7af]/;
// A "." ends a sentence unless it is part of an ellipsis or a decimal number ("6." + "9").
const SENTENCE_END = /[。！？!?…]$|[^.\d]\.$/;
/** Text that starts with punctuation belongs to the previous line. */
const LEADING_PUNCTUATION = /^[、，,。.!?！？…]/;
/** A decimal number split across two pieces: "...6." + "9..." */
const splitDecimal = (before: string, after: string) => /\d\.$/.test(before) && /^\d/.test(after);
const SOFT_BREAK = /[、，,；;：:]$/;
/** Lines longer than this (in characters) are split. */
const maxLineLength = (text: string) =>
  NO_SPACE_SCRIPT.test(text) ? 24 : HANGUL.test(text) ? 32 : 60;
/** A segment is skipped when Whisper itself thinks it is probably not speech. */
const NO_SPEECH_PROB = 0.6;
const LOW_LOGPROB = -0.8;
/** Lines stay on screen at least this long (seconds). */
const MIN_LINE_SECONDS = 1;
/** Gaps shorter than this between lines are bridged, so captions do not flicker. */
const BRIDGE_GAP_SECONDS = 0.4;

/** Appends a word to a line, adding a space only where the script needs one. */
export function joinWord(line: string, word: string): string {
  const trimmed = word.trim();
  if (!line) return trimmed;
  if (/^\s/.test(word)) return `${line} ${trimmed}`; // the API already marks the space
  const last = line.slice(-1);
  const first = trimmed[0] ?? "";
  if (splitDecimal(line, trimmed)) return line + trimmed;
  if (
    NO_SPACE_SCRIPT.test(last) ||
    NO_SPACE_SCRIPT.test(first) ||
    /^[.,!?、。，！？…:;)）」』]/.test(first)
  ) {
    return line + trimmed;
  }
  return `${line} ${trimmed}`;
}

/**
 * Groups words into lines, breaking on sentence ends, long pauses, soft punctuation in a
 * long line, or when a line gets too long or too slow. Does not pad.
 */
export function groupWords(words: readonly Word[]): Cue[] {
  const lines: Cue[] = [];
  let current: Cue | null = null;
  const flush = () => {
    if (current && current.original.trim()) lines.push(current);
    current = null;
  };
  for (const word of words) {
    if (!word.text.trim()) continue;
    const previous = lines.at(-1);
    if (!current && previous && LEADING_PUNCTUATION.test(word.text.trim())) {
      // Punctuation right after a sentence break: keep it on the line it closes.
      previous.original = joinWord(previous.original, word.text);
      previous.end = Math.max(previous.end, word.end);
      continue;
    }
    if (current && !LEADING_PUNCTUATION.test(word.text.trim())) {
      const line: Cue = current;
      const gap = word.start - line.end;
      const length = [...line.original].length;
      const maxLength = maxLineLength(line.original);
      if (
        gap > 0.7 ||
        (gap > 0.25 && SOFT_BREAK.test(line.original) && length > maxLength / 2) ||
        length >= maxLength ||
        word.end - line.start > 7
      ) {
        flush();
      }
    }
    current ??= { start: word.start, end: word.end, original: "" };
    current.original = joinWord(current.original, word.text);
    current.end = word.end;
    if (SENTENCE_END.test(current.original.trim())) flush();
  }
  flush();
  return lines;
}

/**
 * Keeps each line on screen at least MIN_LINE_SECONDS (without running into the next) and
 * bridges small gaps to the next line. Returns new, sorted cues.
 */
export function padLines(cues: readonly Cue[]): Cue[] {
  const out = cues.map((cue) => ({ ...cue })).toSorted((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!;
    const next = out[i + 1];
    const minEnd = cue.start + MIN_LINE_SECONDS;
    cue.end = Math.max(cue.end, next ? Math.min(minEnd, next.start) : minEnd);
    if (next && next.start - cue.end < BRIDGE_GAP_SECONDS) cue.end = next.start;
  }
  return out;
}

/**
 * Joins adjacent segments Whisper split in an odd place: inside a decimal number, or
 * right before a comma. Returns new segments.
 */
export function mergeBrokenSegments(segments: readonly WhisperSegment[]): WhisperSegment[] {
  const out: WhisperSegment[] = [];
  for (const segment of segments) {
    const text = String(segment.text ?? "").trim();
    const last = out.at(-1);
    if (last && text && (splitDecimal(last.text, text) || /^[、，,]/.test(text))) {
      last.text = joinWord(last.text, text);
      last.end = segment.end;
      continue;
    }
    out.push({ ...segment, text });
  }
  return out;
}

/** Repeats closer than this (seconds) to the previous line count as Whisper echoing itself. */
const REPEAT_GAP_SECONDS = 1.5;

/**
 * Drops a line that only repeats the end of the line before it (Whisper sometimes echoes
 * the last words of a chunk). Expects cues sorted by start.
 */
export function dropRepeatedTails(cues: readonly Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const previous = out.at(-1);
    const text = cue.original.trim();
    if (
      previous &&
      cue.start - previous.end < REPEAT_GAP_SECONDS &&
      previous.original.trim().endsWith(text)
    ) {
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }
    out.push({ ...cue });
  }
  return out;
}

/** Converts a Whisper verbose_json response into padded subtitle lines. */
export function whisperToCues(json: WhisperVerboseJson): Cue[] {
  const segments: WhisperSegment[] = Array.isArray(json.segments)
    ? json.segments
    : json.text
      ? [{ start: 0, end: Math.max(2, Number(json.duration) || 5), text: json.text }]
      : [];
  const words: Word[] = (Array.isArray(json.words) ? json.words : [])
    .map((w) => ({
      text: String(w.word ?? w.text ?? ""),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end));

  const cues: Cue[] = [];
  for (const segment of mergeBrokenSegments(segments)) {
    const text = segment.text;
    if (!text || isHallucination(text)) continue;
    if (
      (segment.no_speech_prob ?? 0) > NO_SPEECH_PROB &&
      (segment.avg_logprob ?? 0) < LOW_LOGPROB
    ) {
      continue;
    }
    // Segment times often start early (they snap to the previous segment's end); the
    // words inside the segment give the real timing.
    const inside = words.filter(
      (w) => w.start >= segment.start - 0.05 && w.start < segment.end - 0.01,
    );
    const first = inside[0];
    const last = inside.at(-1);
    if (!first || !last) {
      cues.push({ start: segment.start, end: segment.end, original: text });
    } else if ([...text].length <= maxLineLength(text)) {
      cues.push({ start: first.start, end: Math.max(last.end, first.start + 0.3), original: text });
    } else {
      cues.push(...groupWords(inside).filter((cue) => !isHallucination(cue.original)));
    }
  }
  return padLines(dropRepeatedTails(cues));
}
