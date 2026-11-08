// Layers B and C of the evaluation, on real Whisper runs (debugCapture):
// B: each Whisper segment kept or dropped by the hallucination filters, against where people
//    talk; C: what the viewer gets: speech-time coverage, character error rate against a
//    verbatim creator track, line start/end offsets, and translation against a reference.

import type { Cue } from "../shared/captions.ts";
import { segmentDecisions, type WhisperVerboseJson } from "../background/segmentation.ts";
import { overlapLength, type Interval, type Line } from "./ground-truth.ts";
import { bigramOverlap, cer, chrF, normalizeForCer } from "./text.ts";
import { replayCues, type CaptureLike } from "./timing-eval.ts";

export interface WhisperCapture extends CaptureLike {
  /** Cues as shown at capture time, on the video's timeline. */
  cues: Cue[];
}

export interface Truth {
  speech: Interval[];
  /** Creator lines with text (verbatim tracks), for CER and text matching. */
  lines: Line[];
  /** Creator lines and automatic phrases: anything that might be speech, or null. */
  anySpeech: Interval[] | null;
  reference: Line[] | null;
  supports: { cer: boolean; recall: boolean; precision: boolean; translation: boolean };
}

// ---------- B: filter decisions ----------

export type Label = "speech" | "no speech" | "unsure";

export interface DecisionRow {
  start: number;
  end: number;
  text: string;
  reason: string;
  label: Label;
}

/** Each Whisper segment of each capture, on the video's timeline, with a label. */
export function decisionRows(captures: readonly WhisperCapture[], truth: Truth): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const c of captures) {
    if (!c.raw) continue;
    for (const d of segmentDecisions(c.raw as WhisperVerboseJson, (c.context ?? "").slice(-200))) {
      const first = d.words[0];
      const last = d.words.at(-1);
      const span = {
        start: c.start + (first ? first.start : d.segment.start),
        end: c.start + (last ? last.end : d.segment.end),
      };
      if (span.start >= c.end) continue; // sent again with the next chunk after a trim
      rows.push({
        ...span,
        text: d.segment.text,
        reason: d.reason,
        label: labelSpan(span, d.segment.text, truth),
      });
    }
  }
  return rows;
}

/** Speech when it overlaps creator lines (or its text is theirs); no speech when nothing is near. */
export function labelSpan(span: Interval, text: string, truth: Truth): Label {
  const padded = { start: span.start - 0.5, end: span.end + 0.5 };
  const talk = overlapLength(padded, truth.speech);
  if (talk >= Math.min(0.3, (span.end - span.start) * 0.5)) return "speech";
  if (truth.lines.length) {
    const near = truth.lines
      .filter((l) => l.end > span.start - 3 && l.start < span.end + 3)
      .map((l) => l.text)
      .join("");
    if (near && bigramOverlap(text, near) >= 0.5) return "speech";
  }
  if (!truth.supports.precision || !truth.anySpeech) return "unsure";
  const wide = { start: span.start - 1, end: span.end + 1 };
  return overlapLength(wide, truth.anySpeech) > 0 ? "unsure" : "no speech";
}

export interface FilterScore {
  segments: number;
  keptSpeech: number;
  /** Made-up text that reached the viewer. */
  keptNoSpeech: number;
  keptUnsure: number;
  /** Real speech the filters threw away. */
  droppedSpeech: number;
  droppedNoSpeech: number;
  droppedUnsure: number;
  /** Dropped segments by reason and label. */
  reasons: Record<string, { speech: number; "no speech": number; unsure: number }>;
}

export function scoreFilters(rows: readonly DecisionRow[]): FilterScore {
  const s: FilterScore = {
    segments: rows.length,
    keptSpeech: 0,
    keptNoSpeech: 0,
    keptUnsure: 0,
    droppedSpeech: 0,
    droppedNoSpeech: 0,
    droppedUnsure: 0,
    reasons: {},
  };
  for (const r of rows) {
    if (!r.reason) {
      if (r.label === "speech") s.keptSpeech++;
      else if (r.label === "no speech") s.keptNoSpeech++;
      else s.keptUnsure++;
      continue;
    }
    if (r.label === "speech") s.droppedSpeech++;
    else if (r.label === "no speech") s.droppedNoSpeech++;
    else s.droppedUnsure++;
    const entry = (s.reasons[r.reason] ??= { speech: 0, "no speech": 0, unsure: 0 });
    entry[r.label]++;
  }
  return s;
}

// ---------- C: what the viewer gets ----------

/** The cues a capture shows on the video's timeline: replayed (current code) or as saved. */
export function shownCues(captures: readonly WhisperCapture[], saved = false): Cue[] {
  const out: Cue[] = [];
  for (const c of captures) {
    if (saved) {
      out.push(...c.cues);
      continue;
    }
    if (!c.raw) continue;
    for (const cue of replayCues(c)) {
      const start = c.start + cue.start;
      // what was shown: lines after a trimmed end were sent again with the next chunk
      if (start >= c.end - 0.05) continue;
      out.push({ ...cue, start, end: Math.min(c.start + cue.end, c.end + 1) });
    }
  }
  return out.toSorted((a, b) => a.start - b.start);
}

export interface Offsets {
  n: number;
  median: number | null;
  absMedian: number | null;
  absP90: number | null;
}

const quantile = (a: number[], p: number) =>
  a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))]!;
const round2 = (x: number) => Math.round(x * 100) / 100;

function offsets(values: readonly number[]): Offsets {
  if (!values.length) return { n: 0, median: null, absMedian: null, absP90: null };
  const sorted = values.toSorted((a, b) => a - b);
  const abs = values.map(Math.abs).toSorted((a, b) => a - b);
  return {
    n: values.length,
    median: round2(quantile(sorted, 0.5)),
    absMedian: round2(quantile(abs, 0.5)),
    absP90: round2(quantile(abs, 0.9)),
  };
}

export interface CaptionScore {
  /** The stretch the run covered (first chunk start to last chunk end). */
  window: Interval;
  /** Talk seconds while a line shows / talk seconds. */
  coverage: number | null;
  talkSeconds: number;
  /** Seconds lines show where nobody talks (sources with precision only). */
  shownOutsideSpeech: number | null;
  cer: { cer: number; refChars: number; hypChars: number } | null;
  /** Our line start / end minus the creator's, for lines that start with the same words. */
  start: Offsets;
  end: Offsets;
  /** chrF (0–100) of our translation against the reference, over the window. */
  chrF: number | null;
  lines: number;
}

const HEAD = 2;
const head = (text: string) => [...normalizeForCer(text)].slice(0, HEAD).join("");

export function scoreCaptions(
  captures: readonly WhisperCapture[],
  cues: readonly Cue[],
  truth: Truth,
): CaptionScore {
  const sorted = captures.toSorted((a, b) => a.start - b.start);
  const window = { start: sorted[0]?.start ?? 0, end: sorted.at(-1)?.end ?? 0 };
  const inWindow = (x: Interval) => {
    const mid = (x.start + x.end) / 2;
    return mid >= window.start && mid < window.end;
  };
  const speech = truth.speech
    .filter((s) => s.end > window.start && s.start < window.end)
    .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }));
  let talk = 0;
  let covered = 0;
  for (const s of speech) {
    talk += s.end - s.start;
    covered += overlapLength(s, cues);
  }
  let shownOutside: number | null = null;
  if (truth.supports.precision && truth.anySpeech) {
    const padded = truth.anySpeech.map((s) => ({ start: s.start - 0.5, end: s.end + 0.5 }));
    shownOutside = cues.reduce((sum, c) => sum + (c.end - c.start) - overlapLength(c, padded), 0);
  }
  const lines = truth.lines.filter(inWindow);
  const ours = cues.filter(inWindow);
  let cerScore: CaptionScore["cer"] = null;
  if (truth.supports.cer && lines.length) {
    const r = cer(lines.map((l) => l.text).join(""), ours.map((c) => c.original).join(""));
    cerScore = { cer: Math.round(r.cer * 1000) / 1000, refChars: r.refChars, hypChars: r.hypChars };
  }
  const starts: number[] = [];
  const ends: number[] = [];
  if (truth.supports.recall && truth.lines.length) {
    for (const line of lines) {
      const key = head(line.text);
      if ([...key].length < HEAD) continue;
      const match = ours
        .filter((c) => Math.abs(c.start - line.start) <= 2 && head(c.original) === key)
        .toSorted((a, b) => Math.abs(a.start - line.start) - Math.abs(b.start - line.start))[0];
      if (!match) continue;
      starts.push(match.start - line.start);
      // An end says something only when both lines end the same text and the creator's
      // line is followed by a pause.
      const next = truth.lines.find((l) => l.start > line.start);
      const pauseAfter = !next || next.start - line.end > 0.3;
      const sameEnd =
        normalizeForCer(match.original).slice(-HEAD) === normalizeForCer(line.text).slice(-HEAD);
      if (truth.supports.precision && pauseAfter && sameEnd) ends.push(match.end - line.end);
    }
  }
  let chrf: number | null = null;
  // Translations exist only in the cues saved at capture time (a replay has none).
  const translated = sorted.flatMap((c) => c.cues).filter(inWindow);
  if (truth.reference && translated.some((c) => c.translation)) {
    const ref = truth.reference
      .filter(inWindow)
      .map((l) => l.text)
      .join("");
    const hyp = translated.map((c) => c.translation ?? "").join("");
    if (normalizeForCer(ref)) chrf = Math.round(chrF(ref, hyp) * 10) / 10;
  }
  return {
    window,
    coverage: talk ? Math.round((covered / talk) * 1000) / 1000 : null,
    talkSeconds: Math.round(talk),
    shownOutsideSpeech: shownOutside === null ? null : Math.round(shownOutside * 10) / 10,
    cer: cerScore,
    start: offsets(starts),
    end: offsets(ends),
    chrF: chrf,
    lines: ours.length,
  };
}
