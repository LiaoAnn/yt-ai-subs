// Turns a Whisper verbose_json response into subtitle lines: drops hallucinations, uses
// word timestamps for timing, splits long segments, and pads lines for readability.
// Times here are seconds relative to the start of the audio chunk.

// Relative, with the extension: scripts/qa-replay.ts runs this module in plain Node.
import type { Cue } from "../shared/captions.ts";

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
  compression_ratio?: number;
  /** Decoding temperature; above 0 means Whisper fell back after a failed decode. */
  temperature?: number;
}

export interface WhisperVerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  words?: WhisperWord[];
}

export interface Word {
  text: string;
  start: number;
  end: number;
  /** First word of a Whisper segment: a likely place for a line break. */
  segmentStart?: boolean;
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
/** Below this, Whisper's own decoder counts a segment as failed. */
const FAILED_LOGPROB = -1;
/**
 * Whisper decodes in windows of up to 30 s and re-decodes a failed window at a higher
 * temperature; over music the result is a loop of near-identical made-up sentences. A
 * fallback window whose text (consecutive repeats removed) has fewer distinct character
 * pairs than this share is dropped. Real speech scored 0.89 in testing, music 0.48–0.67.
 */
const FALLBACK_MIN_DISTINCT = 0.75;
/** Prompt repeats shorter than this (characters) can be real ("はい", "15,000원"). */
const MIN_PROMPT_REPEAT = 10;

/** Text compared for repeats: no spaces or punctuation. */
const normalize = (text: string) => text.replace(/[\s、。，,.!?！？…「」]/g, "");

/** Share of distinct character pairs in `text` (1 = no repetition). */
export function distinctPairs(text: string): number {
  const chars = [...text];
  if (chars.length < 2) return 1;
  const pairs = chars.slice(1).map((char, i) => chars[i]! + char);
  return new Set(pairs).size / pairs.length;
}

/** The three-character sequences of `text`. */
function triples(text: string): Set<string> {
  const chars = [...text];
  return new Set(chars.slice(2).map((c, k) => chars[k]! + chars[k + 1]! + c));
}

/**
 * Segments of fallback windows (temperature above 0) that loop on themselves. Segments of
 * one window share their decode statistics, which is how windows are told apart.
 */
export function repetitiveFallbacks(segments: readonly WhisperSegment[]): Set<WhisperSegment> {
  const out = new Set<WhisperSegment>();
  const key = (s: WhisperSegment) => `${s.temperature}:${s.compression_ratio}:${s.avg_logprob}`;
  for (let i = 0; i < segments.length;) {
    let j = i;
    while (j < segments.length && key(segments[j]!) === key(segments[i]!)) j++;
    const window = segments.slice(i, j);
    if ((window[0]!.temperature ?? 0) > 0) {
      const texts = window.map((s) => normalize(s.text));
      const text = texts.filter((t, k) => k === 0 || t !== texts[k - 1]).join("");
      if ([...text].length >= 20 && distinctPairs(text) < FALLBACK_MIN_DISTINCT) {
        // Only the segments that take part in the loop: real speech in the same window
        // shares no three-character sequence with the rest.
        const sets = texts.map(triples);
        window.forEach((segment, k) => {
          const loops = sets.some(
            (other, m) =>
              m !== k && texts[m] !== texts[k] && [...sets[k]!].some((x) => other.has(x)),
          );
          if (loops) out.add(segment);
        });
      }
    }
    i = j;
  }
  return out;
}

export interface RejectContext {
  /** The response has word timestamps but none fall inside this segment. */
  noWords: boolean;
  /** The prompt sent with the request; Whisper repeats it over music and silence. */
  prompt: string;
  /** How many segments right before this one have the same text. */
  repeats: number;
  /** In a fallback window that loops (repetitiveFallbacks). */
  repetitive: boolean;
}

/** Why a segment is probably not real speech, or "" if it looks real. */
export function rejectReason(segment: WhisperSegment, context: RejectContext): string {
  const text = segment.text.trim();
  if (!text) return "empty";
  if (isHallucination(text)) return "known phrase";
  const noSpeech = segment.no_speech_prob ?? 0;
  const logprob = segment.avg_logprob ?? 0;
  if (noSpeech > NO_SPEECH_PROB && logprob < LOW_LOGPROB) return "no speech";
  if (logprob < FAILED_LOGPROB) return "low confidence";
  if (context.repetitive) return "repetitive fallback decode";
  if (context.noWords) return "no words";
  const plain = normalize(text);
  // Two people can say the same thing; three times in a row is a decoding loop.
  if (context.repeats >= 2) return "repeated segment";
  if ([...plain].length >= MIN_PROMPT_REPEAT && normalize(context.prompt).includes(plain)) {
    return "repeats the prompt";
  }
  return "";
}
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

// ---------- breaking a run of words into lines ----------

const KANJI = /[\u3400-\u9fff々〆]/;
const HIRAGANA = /[\u3040-\u309f]/;
const KATAKANA = /[\u30a0-\u30ffｦ-ﾟ]/;
const DIGIT = /[0-9０-９]/;
/** Japanese particles and endings after which a line can break naturally. */
const JA_BREAK_AFTER =
  /(?:ね|よ|な|さ|けど|けれども|ので|から|って|ても|でも|ては|たり|には|では|とは|へ|は|が|を|に|で|と|も|て|た|し|ます|です|でした|ました)$/;
/** Korean connective endings after which a line can break naturally. */
const KO_BREAK_AFTER = /(?:고|서|며|면|데|지만|니까|는데|은데|던데|도|요|죠|다)[,.]?$/;
/** Lines are never longer than this many seconds (unless one word is). */
const MAX_LINE_SECONDS = 7;
/** Pieces shorter than this many characters are avoided when splitting a line. */
const MIN_PIECE_CHARS = 4;

const charCount = (text: string) => [...text.trim()].length;
const lineText = (words: readonly Word[]) => words.reduce((line, w) => joinWord(line, w.text), "");

/**
 * How bad a line break between `before` and `after` is: 0 at a sentence end, about 0.1 at
 * a pause or comma, more inside a phrase, 3 or more inside a word or number.
 */
export function breakPenalty(before: Word, after: Word): number {
  const a = before.text.trim();
  const b = after.text.trim();
  const last = a.slice(-1);
  const first = b[0] ?? "";
  if (SENTENCE_END.test(a)) return 0;
  if (DIGIT.test(last) && (DIGIT.test(first) || first === "." || first === ",")) return 5;
  if (splitDecimal(a, b)) return 5;
  let penalty: number;
  if (SOFT_BREAK.test(a)) penalty = 0.1;
  else if (/^\s/.test(after.text) && NO_SPACE_SCRIPT.test(a + b)) penalty = 0.1; // Whisper's phrase gap
  else if (HANGUL.test(last) || HANGUL.test(first)) {
    // Korean words come one per token: any token boundary is between words.
    penalty = KO_BREAK_AFTER.test(a) ? 0.2 : 0.4;
  } else if (!NO_SPACE_SCRIPT.test(last) && !NO_SPACE_SCRIPT.test(first)) {
    penalty = 0.4; // Latin words
  } else if (DIGIT.test(last)) penalty = 3; // a number and its unit: "1000キロ"
  else if (KATAKANA.test(last) && (KATAKANA.test(first) || first === "ー")) penalty = 3;
  else if (KANJI.test(last) && KANJI.test(first)) penalty = 2;
  else if (KANJI.test(last) && HIRAGANA.test(first)) penalty = 1.5; // okurigana
  else if (HIRAGANA.test(last) && JA_BREAK_AFTER.test(a) && !HIRAGANA.test(first)) penalty = 0.3;
  else if (HIRAGANA.test(last) && JA_BREAK_AFTER.test(a)) penalty = 0.6;
  else penalty = 1;
  const gap = after.start - before.end;
  if (gap >= 0.3) penalty = Math.min(penalty, 0.15);
  if (after.segmentStart) penalty = Math.min(penalty, 0.2);
  return penalty;
}

/**
 * Splits words that are too long or too slow for one line: picks the cheapest break
 * (breakPenalty) near the position that gives balanced lines, and repeats on each part.
 */
function splitBalanced(words: readonly Word[], maxLength: number): Word[][] {
  if (words.length < 2) return [words.slice()];
  const text = lineText(words);
  const length = charCount(text);
  const duration = words.at(-1)!.end - words[0]!.start;
  if (length <= maxLength && duration <= MAX_LINE_SECONDS) return [words.slice()];
  const parts = Math.max(Math.ceil(length / maxLength), Math.ceil(duration / MAX_LINE_SECONDS), 2);
  const ideal = (length * Math.floor(parts / 2)) / parts;
  let best = -1;
  let bestCost = Infinity;
  let before = 0;
  for (let i = 1; i < words.length; i++) {
    before += charCount(words[i - 1]!.text);
    const after = length - before;
    const short = before < MIN_PIECE_CHARS || after < MIN_PIECE_CHARS ? 1 : 0;
    const cost =
      breakPenalty(words[i - 1]!, words[i]!) + (2 * Math.abs(before - ideal)) / length + short;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return [
    ...splitBalanced(words.slice(0, best), maxLength),
    ...splitBalanced(words.slice(best), maxLength),
  ];
}

/** A word's duration beyond this (seconds) is taken as silence or music it absorbed. */
const maxWordSeconds = (word: Word) => 0.4 + 0.2 * charCount(word.text);

/** A line from its words; its edges ignore the silence a stretched first or last word absorbed. */
function toLine(words: readonly Word[]): Cue {
  const first = words[0]!;
  const last = words.at(-1)!;
  const start = Math.max(first.start, Math.min(first.end, last.start) - maxWordSeconds(first));
  const end = Math.max(start + 0.3, Math.min(last.end, last.start + maxWordSeconds(last)));
  return { start, end, original: lineText(words) };
}

/**
 * Groups words into lines: always breaks at sentence ends and long pauses, then splits
 * what is still too long into balanced lines at natural breaks, and merges tiny leftovers
 * into a neighbour. Does not pad.
 */
export function groupWords(words: readonly Word[]): Cue[] {
  // Runs between hard breaks; punctuation stays on the line it closes.
  const runs: Word[][] = [];
  let run: Word[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const previous = run.at(-1) ?? runs.at(-1)?.at(-1);
    if (previous && LEADING_PUNCTUATION.test(text) && !run.length) {
      runs.at(-1)!.push(word);
      continue;
    }
    if (run.length && word.start - run.at(-1)!.end > 0.7 && !LEADING_PUNCTUATION.test(text)) {
      runs.push(run);
      run = [];
    }
    run.push(word);
    if (SENTENCE_END.test(lineText(run))) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);

  // A fragment of a few characters reads badly on its own: join it to its neighbour in
  // the same run when the result still fits.
  const merged: Word[][] = [];
  for (const r of runs) {
    const pieces = splitBalanced(r, maxLineLength(lineText(r)));
    for (const [index, piece] of pieces.entries()) {
      const previous = index > 0 ? merged.at(-1) : undefined;
      if (previous) {
        const joined = [...previous, ...piece];
        const fits =
          charCount(lineText(joined)) <= maxLineLength(lineText(joined)) &&
          joined.at(-1)!.end - joined[0]!.start <= MAX_LINE_SECONDS;
        const tiny =
          charCount(lineText(piece)) < MIN_PIECE_CHARS ||
          charCount(lineText(previous)) < MIN_PIECE_CHARS;
        if (tiny && fits) {
          previous.push(...piece);
          continue;
        }
      }
      merged.push([...piece]);
    }
  }
  return merged.map(toLine);
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

/** Characters of `text` that count when matching words to segments. */
const size = (text: string) => [...normalize(text)].length;

/**
 * The words of each segment. Whisper's words come in transcript order, and their text adds
 * up to the segments' text, but their times overlap when people talk over each other: so
 * words are matched by text position, and by time only if the texts do not line up.
 */
export function wordsBySegment(
  segments: readonly WhisperSegment[],
  words: readonly Word[],
): Word[][] {
  const textSize = segments.reduce((sum, s) => sum + size(s.text), 0);
  if (textSize === words.reduce((sum, w) => sum + size(w.text), 0)) {
    let next = 0;
    return segments.map((segment) => {
      const need = size(segment.text);
      const own: Word[] = [];
      let have = 0;
      // Punctuation-only words right after stay with the segment they close.
      while (next < words.length && (have < need || size(words[next]!.text) === 0)) {
        have += size(words[next]!.text);
        own.push(words[next++]!);
      }
      return own;
    });
  }
  return segments.map((segment) =>
    words.filter((w) => w.start >= segment.start - 0.05 && w.start < segment.end - 0.01),
  );
}

/** A line that would show for less than this (seconds) is joined to the next one. */
const MIN_READ_SECONDS = 0.8;

/**
 * Joins lines that follow each other too fast to read (rapid dialogue: "15,000원?",
 * "15,000원.", …) into one line, as long as the result fits. Expects sorted lines.
 */
export function mergeHurriedLines(lines: readonly Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const line of lines) {
    const previous = out.at(-1);
    if (previous) {
      const text = joinWord(previous.original, ` ${line.original}`);
      const hurried = line.start - previous.start < MIN_READ_SECONDS;
      const close = line.start - previous.end < 0.5;
      const fits =
        charCount(text) <= maxLineLength(text) && line.end - previous.start <= MAX_LINE_SECONDS;
      if (hurried && close && fits) {
        previous.original = text;
        previous.end = Math.max(previous.end, line.end);
        continue;
      }
    }
    out.push({ ...line });
  }
  return out;
}

export interface SegmentDecision {
  segment: WhisperSegment;
  /** The words matched to this segment (by text position), with video-chunk times. */
  words: Word[];
  /** Why the segment is dropped (rejectReason), or "" when it is kept. */
  reason: string;
}

/** Whisper's response as segments and words, the shape both segmentation steps share. */
function parseResponse(json: WhisperVerboseJson): {
  segments: WhisperSegment[];
  words: Word[];
  hasWordTimes: boolean;
} {
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
  return { segments, words, hasWordTimes: Array.isArray(json.words) };
}

/**
 * Keeps or drops each segment of a Whisper response (after merging broken segments), with
 * the words that belong to it. whisperToLines builds the lines from the kept ones; the
 * offline evaluation (src/qa/) scores the decisions against ground truth.
 */
export function segmentDecisions(json: WhisperVerboseJson, context = ""): SegmentDecision[] {
  const { segments, words, hasWordTimes } = parseResponse(json);
  const merged = mergeBrokenSegments(segments);
  const repetitive = repetitiveFallbacks(merged);
  const owned = wordsBySegment(merged, words);
  let previous = "";
  let repeats = 0;
  return merged.map((segment, index) => {
    const text = segment.text;
    // Segment times often start early (they snap to the previous segment's end); the
    // words inside the segment give the real timing.
    const inside = owned[index]!.map((w, i) => ({ ...w, segmentStart: i === 0 }));
    repeats = normalize(text) && normalize(text) === normalize(previous) ? repeats + 1 : 0;
    previous = text;
    const reason = rejectReason(segment, {
      noWords: hasWordTimes && !inside.length,
      prompt: context,
      repeats,
      repetitive: repetitive.has(segment),
    });
    return { segment, words: inside, reason };
  });
}

/**
 * Subtitle lines from a Whisper verbose_json response, unpadded: drops hallucinations and
 * probable non-speech, then groups each segment's words into lines (a segment of a few
 * characters joins its neighbour; a run-on segment is split into balanced lines).
 */
export function whisperToLines(json: WhisperVerboseJson, context = ""): Cue[] {
  const lines: Cue[] = [];
  let stream: Word[] = [];
  const flush = () => {
    lines.push(...groupWords(stream).filter((cue) => !isHallucination(cue.original)));
    stream = [];
  };
  for (const { segment, words: inside, reason } of segmentDecisions(json, context)) {
    const text = segment.text;
    if (reason) {
      flush(); // never join lines across a dropped segment
      continue;
    }
    if (!inside.length) {
      flush();
      lines.push({ start: segment.start, end: segment.end, original: text });
      continue;
    }
    // Words may come without the punctuation the segment text ends with.
    const closing = /[。！？!?]$/.exec(text)?.[0];
    const last = inside.at(-1)!;
    if (closing && !/[。！？!?]$/.test(last.text.trim())) {
      last.text = last.text.replace(/[、，,.]?\s*$/, closing);
    }
    // Segment boundaries are often a change of speaker: lines break there, except that a
    // segment of a few characters joins its neighbour.
    const tiny = (ws: readonly Word[]) => charCount(lineText(ws)) < MIN_PIECE_CHARS;
    if (stream.length && !tiny(stream) && !tiny(inside)) flush();
    stream.push(...inside);
  }
  flush();
  return mergeHurriedLines(lines.toSorted((a, b) => a.start - b.start));
}

/** Converts a Whisper verbose_json response into padded subtitle lines. */
export function whisperToCues(json: WhisperVerboseJson, context = ""): Cue[] {
  return padLines(dropRepeatedTails(whisperToLines(json, context)));
}
