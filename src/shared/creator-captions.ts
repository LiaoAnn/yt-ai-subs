// Caption tracks the video's creator uploaded (pure logic, shared by the page script and
// the content script). Two uses:
//
// - A creator track in the language our track would show (the translation target, e.g. a
//   zh-Hant track for a zh-TW viewer): nothing is transcribed or translated; the page
//   script selects that track instead of adding ours (targetTrack).
// - A creator track in the spoken language (ja / ko): its lines replace Whisper's and are
//   only translated (sourceTracks, analyzeCreatorTrack), unless it turns out to be a copy
//   of YouTube's automatic captions or covers only part of the speech.
//
// How tracks are listed and fetched, and the traps: the research-youtube-captions skill.

// Relative, with the extension: the offline evaluation (src/qa/) runs this module in plain Node.
import type { Cue, Json3Event } from "./captions.ts";

/** The fields of a player response's `captionTracks[]` entry used here. */
export interface CaptionTrackInfo {
  languageCode: string;
  /** "asr" for YouTube's automatic captions; absent for uploaded tracks. */
  kind?: string;
  vssId: string;
  name: string;
  baseUrl: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function trackName(name: unknown): string {
  if (!isObject(name)) return "";
  if (typeof name.simpleText === "string") return name.simpleText;
  if (Array.isArray(name.runs)) {
    return name.runs
      .map((run) => (isObject(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
  }
  return "";
}

/** The usable entries of a player response's captionTracks (ours excluded). */
export function readCaptionTracks(captionTracks: unknown, isOurs: (vssId: string) => boolean) {
  if (!Array.isArray(captionTracks)) return [];
  const out: CaptionTrackInfo[] = [];
  for (const entry of captionTracks) {
    if (!isObject(entry)) continue;
    const { languageCode, vssId, baseUrl, kind } = entry;
    if (typeof languageCode !== "string" || typeof baseUrl !== "string") continue;
    if (typeof vssId !== "string" || isOurs(vssId)) continue;
    out.push({
      languageCode,
      ...(typeof kind === "string" && kind ? { kind } : {}),
      vssId,
      name: trackName(entry.name),
      baseUrl,
    });
  }
  return out;
}

const baseLanguage = (code: string) => code.toLowerCase().split("-")[0]!;

/** Traditional Chinese: zh-Hant(-…), zh-TW, zh-HK, zh-MO. Plain "zh" is ambiguous. */
export function isTraditionalChinese(code: string): boolean {
  const lower = code.toLowerCase();
  return lower.startsWith("zh-hant") || lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo";
}

/** Whether a track in `code` shows text in `wanted` (our track's language). */
export function languageMatches(code: string, wanted: string): boolean {
  if (baseLanguage(wanted) === "zh") {
    return isTraditionalChinese(wanted)
      ? isTraditionalChinese(code)
      : code.toLowerCase() === wanted.toLowerCase();
  }
  return baseLanguage(code) === baseLanguage(wanted);
}

const isCreator = (track: CaptionTrackInfo) => !track.kind;

/**
 * A creator track already in the translation target: use it and spend nothing. Only when
 * translating (with translation off, our track is the spoken language: see sourceTracks).
 */
export function targetTrack(
  tracks: readonly CaptionTrackInfo[],
  target: string,
): CaptionTrackInfo | null {
  return (
    tracks.find((track) => isCreator(track) && languageMatches(track.languageCode, target)) ?? null
  );
}

/**
 * The creator track in the spoken language and YouTube's automatic track to compare it
 * with. The spoken language is the setting, or (auto) the automatic track's language.
 */
export function sourceTracks(
  tracks: readonly CaptionTrackInfo[],
  sourceLanguage: string,
): { creator: CaptionTrackInfo; asr: CaptionTrackInfo | null } | null {
  const asrAny = tracks.find((track) => track.kind === "asr") ?? null;
  const spoken = sourceLanguage === "auto" ? asrAny?.languageCode : sourceLanguage;
  if (!spoken) return null;
  const creator = tracks.find(
    (track) => isCreator(track) && baseLanguage(track.languageCode) === baseLanguage(spoken),
  );
  if (!creator) return null;
  const asr =
    tracks.find(
      (track) => track.kind === "asr" && baseLanguage(track.languageCode) === baseLanguage(spoken),
    ) ?? null;
  return { creator, asr };
}

export interface CaptionLine {
  start: number;
  end: number;
  text: string;
}

/**
 * json3 events as lines (seconds). Skips events without text (YouTube's automatic tracks
 * carry newline-only "append" events); an event without a duration ends where the next
 * one starts. Line breaks inside an event become spaces.
 */
export function json3Lines(events: readonly Json3Event[]): CaptionLine[] {
  const sorted = events
    .filter((event) => Number.isFinite(event.tStartMs) && Array.isArray(event.segs))
    .toSorted((a, b) => a.tStartMs - b.tStartMs);
  const lines: CaptionLine[] = [];
  sorted.forEach((event, i) => {
    const text = event.segs
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (!text) return;
    const start = event.tStartMs / 1000;
    const duration =
      Number.isFinite(event.dDurationMs) && event.dDurationMs > 0 ? event.dDurationMs : null;
    const nextStart = sorted[i + 1]?.tStartMs;
    const endMs =
      duration !== null ? event.tStartMs + duration : (nextStart ?? event.tStartMs + 3000);
    lines.push({ start, end: Math.max(endMs / 1000, start + 0.3), text });
  });
  return lines;
}

/** Creator lines as cues (originals only; translation comes later). */
export const linesToCues = (lines: readonly CaptionLine[]): Cue[] =>
  lines.map((line) => ({ start: line.start, end: line.end, original: line.text }));

/** Text compared for the error rate: no spaces, punctuation or symbols, lower case. */
export const normalizeText = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");

/** Levenshtein distance (two rows; inputs are capped by the caller). */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let previous = new Int32Array(y.length + 1);
  let current = new Int32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) previous[j] = j;
  for (let i = 1; i <= x.length; i++) {
    current[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const substitution = previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[y.length]!;
}

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export const ANALYSIS_LIMITS = {
  /** Only this much of the video is compared (the start is enough to tell). */
  windowSeconds: 600,
  /** Characters compared per side, so the edit distance stays cheap. */
  maxChars: 3000,
  /** A creator line start counts as matched to an automatic one within this. */
  matchSeconds: 2,
  /** A copy: error rate to the automatic track below this... */
  copyCer: 0.1,
  /** ...and line starts equal to the automatic ones (p90 of |difference|) within this. */
  copyOffsetSeconds: 0.1,
  /** Share of the automatic track's speech the creator lines must cover. */
  minCoverage: 0.5,
};

export interface CreatorAnalysis {
  /** Use the creator track instead of Whisper. */
  usable: boolean;
  /** Why not (for the log), or "" when usable. */
  reason: string;
  /** Character error rate of the creator text against the automatic track (NaN without one). */
  cer: number;
  /** Median and p90 of |creator line start − nearest automatic line start|, seconds. */
  medianOffset: number;
  p90Offset: number;
  /** Share of the automatic track's lines that a creator line overlaps (±1 s). */
  coverage: number;
  lines: number;
}

/**
 * Whether a creator track can replace Whisper. Without an automatic track to compare with,
 * it is trusted. Rejected when it is a copy of the automatic track (same text and the same
 * start times: the text then has the automatic track's mistakes), or when it covers too
 * little of the speech (summary cards, a silent vlog's descriptions).
 */
export function analyzeCreatorTrack(
  creator: readonly CaptionLine[],
  asr: readonly CaptionLine[] | null,
  limits = ANALYSIS_LIMITS,
): CreatorAnalysis {
  const base = {
    cer: Number.NaN,
    medianOffset: Number.NaN,
    p90Offset: Number.NaN,
    coverage: Number.NaN,
    lines: creator.length,
  };
  if (!creator.length) return { ...base, usable: false, reason: "創作者字幕是空的" };
  if (!asr?.length) return { ...base, usable: true, reason: "" };

  const from = Math.min(creator[0]!.start, asr[0]!.start);
  const until = from + limits.windowSeconds;
  const inWindow = (line: CaptionLine) => line.start < until;
  const creatorWindow = creator.filter(inWindow);
  const asrWindow = asr.filter(inWindow);

  const creatorText = normalizeText(creatorWindow.map((line) => line.text).join("")).slice(
    0,
    limits.maxChars,
  );
  const asrText = normalizeText(asrWindow.map((line) => line.text).join("")).slice(
    0,
    limits.maxChars,
  );
  const cer = asrText.length ? editDistance(creatorText, asrText) / asrText.length : 1;

  const asrStarts = asrWindow.map((line) => line.start);
  const offsets: number[] = [];
  for (const line of creatorWindow) {
    let best = Infinity;
    for (const start of asrStarts) {
      const diff = Math.abs(line.start - start);
      if (diff < best) best = diff;
    }
    if (best <= limits.matchSeconds) offsets.push(best);
  }
  offsets.sort((a, b) => a - b);
  const medianOffset = quantile(offsets, 0.5);
  const p90Offset = quantile(offsets, 0.9);

  const speech = asrWindow.filter((line) => !/^[[(（【].*[\])）】]$/.test(line.text));
  const covered = speech.filter((line) => {
    const middle = (line.start + line.end) / 2;
    return creator.some((c) => c.start - 1 <= middle && middle <= c.end + 1);
  });
  const coverage = speech.length ? covered.length / speech.length : 1;

  const result = { ...base, cer, medianOffset, p90Offset, coverage };
  if (cer < limits.copyCer && offsets.length && p90Offset <= limits.copyOffsetSeconds) {
    return { ...result, usable: false, reason: "創作者字幕是自動字幕的副本" };
  }
  if (coverage < limits.minCoverage) {
    return { ...result, usable: false, reason: "創作者字幕只涵蓋部分台詞" };
  }
  return { ...result, usable: true, reason: "" };
}

const round = (value: number) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : "-");

/** Rounds the analysis numbers for a log line. */
export function describeAnalysis(analysis: CreatorAnalysis): string {
  return `cer ${round(analysis.cer)}, start offset median ${round(analysis.medianOffset)} s / p90 ${round(analysis.p90Offset)} s, coverage ${round(analysis.coverage)}, ${analysis.lines} lines`;
}
