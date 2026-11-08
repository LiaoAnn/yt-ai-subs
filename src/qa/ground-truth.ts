// Ground truth from YouTube caption tracks (json3), filtered by the trap rules of the
// research-youtube-captions skill: creator tracks that are copies of the automatic track,
// tracks whose timing is YouTube's alignment, summary cards. Caption text is other people's
// work: what this module returns stays in .qa/ (gitignored); only speech intervals (no
// text) may be committed.

import { cer, isNonSpeech, normalizeForCer, speechText } from "./text.ts";

export interface Interval {
  start: number;
  end: number;
}

export interface Line extends Interval {
  text: string;
}

/** One track as fetched (scripts/qa-eval.ts reads these from .qa/gt/<id>.json). */
export interface FetchedTrack {
  languageCode: string;
  kind: string | null;
  vssId: string;
  name?: string;
  json: Json3 | null;
}

export interface FetchedVideo {
  videoId: string;
  title?: string;
  author?: string;
  lengthSeconds: number;
  publishDate?: string;
  error?: string;
  trackList?: { languageCode: string; kind: string | null; vssId: string }[];
  tracks: FetchedTrack[];
}

export interface Json3 {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    aAppend?: number;
    segs?: { utf8?: string; tOffsetMs?: number }[];
  }[];
}

/** Lines of a creator track: one per event with text, in seconds. */
export function creatorLines(json: Json3 | null): Line[] {
  const lines: Line[] = [];
  for (const event of json?.events ?? []) {
    const text = (event.segs ?? []).map((s) => s.utf8 ?? "").join("");
    if (!text.trim() || event.tStartMs === undefined) continue;
    const start = event.tStartMs / 1000;
    lines.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
  }
  return lines.toSorted((a, b) => a.start - b.start);
}

export interface AsrWord {
  start: number;
  text: string;
}

export interface AsrTrack {
  /** Phrases as shown; `end` is where the next phrase starts (rolling captions). */
  lines: Line[];
  /** Word starts: segs with tOffsetMs; the first seg of an event starts with the event. */
  words: AsrWord[];
  /** Share of events with more than one seg (word timing); 2026 tracks often have little. */
  wordTimed: number;
}

/** YouTube's automatic track: rolling two-line captions with word offsets. */
export function asrTrack(json: Json3 | null): AsrTrack {
  const events = (json?.events ?? []).filter(
    (e) => e.tStartMs !== undefined && !e.aAppend && (e.segs ?? []).some((s) => s.utf8?.trim()),
  );
  const lines: Line[] = [];
  const words: AsrWord[] = [];
  let timed = 0;
  events.forEach((event, i) => {
    const start = event.tStartMs! / 1000;
    const shownUntil = start + (event.dDurationMs ?? 0) / 1000;
    const next = events[i + 1]?.tStartMs;
    const end = Math.min(shownUntil, next === undefined ? shownUntil : next / 1000);
    const segs = event.segs ?? [];
    if (segs.length > 1) timed++;
    for (const seg of segs) {
      if (!seg.utf8?.trim()) continue;
      words.push({ start: start + (seg.tOffsetMs ?? 0) / 1000, text: seg.utf8 });
    }
    lines.push({
      start,
      end: Math.max(end, start + 0.3),
      text: segs.map((s) => s.utf8 ?? "").join(""),
    });
  });
  return { lines, words, wordTimed: events.length ? timed / events.length : 0 };
}

const SOUND_NOTE =
  /^\s*[[［(（]\s*(音楽|拍手|笑い|笑|歌声|음악|박수|웃음|music|applause|laughter)[^\]］)）]*[\]］)）]\s*$/i;

/** Automatic-track phrases that are speech (not `[音楽]`-style notes). */
export function asrSpeech(asr: AsrTrack): Interval[] {
  return asr.lines
    .filter((l) => !SOUND_NOTE.test(l.text) && !isNonSpeech(l.text))
    .map(({ start, end }) => ({ start, end }));
}

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

export interface TrackStats {
  lines: number;
  /** Creator line start minus the nearest automatic word start within ±2 s (seconds). */
  startOffset: { n: number; median: number; absMedian: number; absP90: number };
  /** Character difference to the automatic track (includes the automatic track's errors). */
  cerVsAsr: number | null;
  /** Share of the automatic track's speech time that creator lines cover. */
  asrCovered: number | null;
  /** Share of the video covered by creator lines. */
  coverage: number;
  /** Share of gaps between consecutive lines longer than 0.3 s. */
  gapShare: number;
  /** Share of lines that are only a card, a note or a label. */
  nonSpeechShare: number;
  asrWordTimed: number | null;
}

/** Total length of the union of intervals. */
export function unionLength(intervals: readonly Interval[]): number {
  let total = 0;
  let open = -Infinity;
  let close = -Infinity;
  for (const { start, end } of intervals.toSorted((a, b) => a.start - b.start)) {
    if (start > close) {
      if (close > open) total += close - open;
      open = start;
      close = end;
    } else close = Math.max(close, end);
  }
  if (close > open) total += close - open;
  return total;
}

/** Length of the overlap of `a` with the union of `b`. */
export function overlapLength(a: Interval, b: readonly Interval[]): number {
  const parts = b
    .filter((x) => x.end > a.start && x.start < a.end)
    .map((x) => ({ start: Math.max(a.start, x.start), end: Math.min(a.end, x.end) }));
  return unionLength(parts);
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const lang = (code: string) => code.split("-")[0];

/** Compares a creator track with the automatic track of the same language. */
export function trackStats(
  lines: readonly Line[],
  asr: AsrTrack | null,
  lengthSeconds: number,
): TrackStats {
  const speech = lines.filter((l) => !isNonSpeech(l.text));
  const offsets: number[] = [];
  if (asr) {
    // Only where the text says it is the same moment: an automatic word (seg) that starts
    // with the line's first two characters. With sparse word timing the nearest start alone
    // would often belong to another phrase.
    const words = asr.words.map((w) => ({ start: w.start, text: normalizeForCer(w.text) }));
    for (const line of speech) {
      const key = [...normalizeForCer(speechText(line.text))].slice(0, 2).join("");
      if ([...key].length < 2) continue;
      let best: number | null = null;
      for (const w of words) {
        if (w.start < line.start - 2) continue;
        if (w.start > line.start + 2) break;
        if (!w.text.startsWith(key)) continue;
        if (best === null || Math.abs(w.start - line.start) < Math.abs(best))
          best = w.start - line.start;
      }
      if (best !== null) offsets.push(-best);
    }
  }
  const sorted = offsets.toSorted((a, b) => a - b);
  const abs = offsets.map(Math.abs).toSorted((a, b) => a - b);
  let cerVsAsr: number | null = null;
  let asrCovered: number | null = null;
  if (asr && asr.lines.length) {
    // Compare in one-minute blocks, so a dropped stretch cannot shift the whole alignment.
    let edits = 0;
    let chars = 0;
    const last = Math.max(...speech.map((l) => l.end), ...asr.lines.map((l) => l.end), 0);
    for (let from = 0; from < last; from += 60) {
      const inBlock = (l: Line) => l.start >= from && l.start < from + 60;
      const ref = speech
        .filter(inBlock)
        .map((l) => speechText(l.text))
        .join("");
      const hyp = asr.lines
        .filter(inBlock)
        .filter((l) => !SOUND_NOTE.test(l.text))
        .map((l) => speechText(l.text))
        .join("");
      if (!normalizeForCer(ref) && !normalizeForCer(hyp)) continue;
      const r = cer(ref, hyp);
      edits += r.edits;
      chars += r.refChars;
    }
    cerVsAsr = chars ? edits / chars : null;
    const asrSpans = asrSpeech(asr);
    const asrTotal = unionLength(asrSpans);
    asrCovered = asrTotal
      ? asrSpans.reduce((sum, span) => sum + overlapLength(span, speech), 0) / asrTotal
      : null;
  }
  let gaps = 0;
  for (let i = 1; i < speech.length; i++) if (speech[i]!.start - speech[i - 1]!.end > 0.3) gaps++;
  return {
    lines: speech.length,
    startOffset: {
      n: offsets.length,
      median: round(quantile(sorted, 0.5)),
      absMedian: round(quantile(abs, 0.5)),
      absP90: round(quantile(abs, 0.9)),
    },
    cerVsAsr: cerVsAsr === null ? null : round(cerVsAsr),
    asrCovered: asrCovered === null ? null : round(asrCovered),
    coverage: round(unionLength(speech) / (lengthSeconds || 1)),
    gapShare: round(speech.length > 1 ? gaps / (speech.length - 1) : 0),
    nonSpeechShare: round(lines.length ? 1 - speech.length / lines.length : 0),
    asrWordTimed: asr ? round(asr.wordTimed) : null,
  };
}

export interface Supports {
  /** Whisper's character error rate (creator track close to verbatim, same language). */
  cer: boolean;
  /** Speech recall: where people talk (line starts within about ±1 s). */
  recall: boolean;
  /** Precision: where nobody talks (lines leave gaps, own timing). */
  precision: boolean;
  /** A Traditional Chinese reference translation. */
  translation: boolean;
}

export interface GroundTruth {
  videoId: string;
  language: string;
  lengthSeconds: number;
  /**
   * The track speech times come from: the creator's text of the speech (verbatim), the
   * creator's translation of it, or YouTube's automatic track (no creator track at all).
   */
  source: { vssId: string; kind: "verbatim" | "translation" | "automatic" } | null;
  /** Creator lines that are speech (cards and labels dropped from the text). */
  lines: Line[];
  /** Spans where the automatic track heard speech (no `[音楽]` notes). */
  asrSpeech: Interval[];
  stats: TrackStats | null;
  /** Trap rules that matched, and other notes (k of n style counts in the report). */
  flags: string[];
  supports: Supports;
  /** Traditional Chinese reference translation lines, if any. */
  reference: { vssId: string; lines: Line[] } | null;
}

const SIMPLIFIED = /[这们说为对时会来过还么国学发见门问东车长开关头听点让觉谢]/g;
const TRADITIONAL = /[這們說為對時會來過還麼國學發見門問東車長開關頭聽點讓覺謝]/g;

/** Whether a Chinese track is written in Traditional characters. */
export function isTraditional(lines: readonly Line[]): boolean {
  const text = lines.map((l) => l.text).join("");
  const s = text.match(SIMPLIFIED)?.length ?? 0;
  const t = text.match(TRADITIONAL)?.length ?? 0;
  return t > s * 3 && t > 5;
}

/** Thresholds of the trap rules (research-youtube-captions skill). */
export const TRAP = {
  /** |median| and |p90| of the start offset below this: the timing is the automatic track's. */
  alignedSeconds: 0.03,
  /** A creator track this close to the automatic one is a copy. */
  copiedCer: 0.1,
  /** Further from the automatic track than this: rewritten, not verbatim. */
  verbatimCer: 0.5,
  /** The creator track covers less of the automatic track's speech: summary or omissions. */
  minAsrCovered: 0.6,
  /** Lines leave gaps often enough to say where speech ends. */
  minGapShare: 0.2,
  /** Start offsets loose beyond this p90 cannot judge speech timing. */
  maxStartP90: 1.0,
};

/**
 * Builds the ground truth of one video in `language` (the spoken language): picks the
 * creator track, applies the trap rules, and records what it can measure.
 */
export function groundTruth(video: FetchedVideo, language: string): GroundTruth {
  const creator = video.tracks.filter((t) => !t.kind && t.json);
  const asrJson =
    video.tracks.find((t) => t.kind === "asr" && lang(t.languageCode) === language)?.json ?? null;
  const asr = asrJson ? asrTrack(asrJson) : null;
  const flags: string[] = [];
  const zh = creator
    .filter((t) => lang(t.languageCode) === "zh")
    .map((t) => ({ vssId: t.vssId, code: t.languageCode, lines: creatorLines(t.json) }))
    .filter((t) => t.lines.length && isTraditional(t.lines))
    .toSorted(
      (a, b) =>
        Number(b.code === "zh-Hant" || b.code === "zh-TW") -
        Number(a.code === "zh-Hant" || a.code === "zh-TW"),
    );
  const reference = zh[0] ? { vssId: zh[0].vssId, lines: zh[0].lines } : null;
  const supports: Supports = { cer: false, recall: false, precision: false, translation: false };
  const same = creator.find((t) => lang(t.languageCode) === language);
  const base = {
    videoId: video.videoId,
    language,
    lengthSeconds: video.lengthSeconds,
    asrSpeech: asr ? asrSpeech(asr) : [],
    reference,
  };
  if (!same) {
    // A translation track still says where people talk (line starts), not what they said.
    const translated =
      reference ?? creator.map((t) => ({ vssId: t.vssId, lines: creatorLines(t.json) }))[0];
    if (!translated && asr) {
      // Only YouTube's automatic track: not ground truth for text, but where it heard
      // speech is a (weak) label for voice detection's recall.
      const lines = asr.lines
        .filter((l) => !SOUND_NOTE.test(l.text) && !isNonSpeech(l.text))
        .map((l) => ({ ...l, text: speechText(l.text) }));
      flags.push("automatic track only: weak speech labels, recall only");
      supports.recall = lines.length > 0;
      const asrVss = video.tracks.find(
        (t) => t.kind === "asr" && lang(t.languageCode) === language,
      )!.vssId;
      return {
        ...base,
        source: { vssId: asrVss, kind: "automatic" },
        lines,
        stats: null,
        flags,
        supports,
      };
    }
    if (!translated) {
      flags.push("no creator track");
      return { ...base, source: null, lines: [], stats: null, flags, supports };
    }
    const lines = translated.lines.filter((l) => !isNonSpeech(l.text));
    const stats = trackStats(lines, asr, video.lengthSeconds);
    flags.push("translation track only");
    supports.recall = lines.length > 0;
    supports.translation = reference !== null;
    return {
      ...base,
      source: { vssId: translated.vssId, kind: "translation" },
      lines,
      stats,
      flags,
      supports,
    };
  }
  const all = creatorLines(same.json);
  const lines = all
    .filter((l) => !isNonSpeech(l.text))
    .map((l) => ({ ...l, text: speechText(l.text) }));
  const stats = trackStats(all, asr, video.lengthSeconds);
  const aligned =
    stats.startOffset.n >= 20 &&
    Math.abs(stats.startOffset.median) < TRAP.alignedSeconds &&
    stats.startOffset.absP90 < TRAP.alignedSeconds;
  const copied = aligned && stats.cerVsAsr !== null && stats.cerVsAsr < TRAP.copiedCer;
  if (copied) {
    flags.push("copy of the automatic track");
    return {
      ...base,
      source: { vssId: same.vssId, kind: "verbatim" },
      lines,
      stats,
      flags,
      supports,
    };
  }
  if (aligned) flags.push("timing aligned by YouTube");
  const summary = stats.asrCovered !== null && stats.asrCovered < TRAP.minAsrCovered;
  if (summary)
    flags.push(
      `covers ${Math.round((stats.asrCovered ?? 0) * 100)}% of the automatic track's speech`,
    );
  const rewritten = stats.cerVsAsr !== null && stats.cerVsAsr > TRAP.verbatimCer;
  if (rewritten) flags.push(`differs from the automatic track by ${stats.cerVsAsr}`);
  if (!asr) flags.push("no automatic track to check against");
  const loose = stats.startOffset.n >= 20 && stats.startOffset.absP90 > TRAP.maxStartP90;
  if (loose) flags.push(`loose timing (p90 ${stats.startOffset.absP90} s)`);
  supports.cer = !!asr && !summary && !rewritten;
  supports.recall = !aligned && !summary && !loose && lines.length > 0;
  supports.precision = supports.recall && !!asr && stats.gapShare >= TRAP.minGapShare;
  supports.translation = reference !== null;
  return {
    ...base,
    source: { vssId: same.vssId, kind: "verbatim" },
    lines,
    stats,
    flags,
    supports,
  };
}

/**
 * Where people talk, for the measures: creator lines (merged when they touch), as
 * intervals without text. This is what may be committed.
 */
export function speechIntervals(lines: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const { start, end } of lines.toSorted((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && start <= last.end + 0.05) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out.map((x) => ({
    start: Math.round(x.start * 100) / 100,
    end: Math.round(x.end * 100) / 100,
  }));
}
