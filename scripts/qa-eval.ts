// Scores the extension's captions on the evaluation set (src/qa/dataset.ts), without calling
// any API: ground truth from creator caption tracks (.qa/gt/<id>.json), voice features from
// dry runs (.qa/dry/<id>.json) and Whisper responses from real runs (.qa/whisper/<id>.json).
// How to collect them: the test-extension-in-browser skill. Keep .qa/ out of git.
//
//   node scripts/qa-eval.ts                      tables per video and per category
//   node scripts/qa-eval.ts --video <id>         one video, with the line-level details
//   node scripts/qa-eval.ts --saved              layer C on the cues saved at capture time
//   node scripts/qa-eval.ts --json <file>        also write every number as JSON
//   node scripts/qa-eval.ts --dataset            the dataset table (supported measurements)
//   node scripts/qa-eval.ts --write-fixture <id> <from> <to> <name>
//                                                write a CI fixture (features + speech
//                                                intervals, no text) to src/test/eval/
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATASET, type DatasetVideo } from "../src/qa/dataset.ts";
import {
  groundTruth,
  speechIntervals,
  type FetchedVideo,
  type GroundTruth,
  type Interval,
} from "../src/qa/ground-truth.ts";
import {
  featureTimeline,
  scoreChunks,
  simulateChunks,
  type FeatureCapture,
  type FeatureTimeline,
  type SpeechTruth,
  type VoiceScore,
} from "../src/qa/voice-eval.ts";
import {
  decisionRows,
  scoreCaptions,
  scoreFilters,
  shownCues,
  type CaptionScore,
  type FilterScore,
  type Truth,
  type WhisperCapture,
} from "../src/qa/caption-eval.ts";
import { audioProblem, type AudioState } from "../src/qa/audio-track.ts";
import { fixtureFrom } from "../src/qa/fixture.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = option("--dir") ?? ".qa";

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

interface CaptureFile<T> {
  captures: Record<string, T>;
  /** The player's audio tracks when the capture was made (absent in early captures). */
  audio?: AudioState;
}

/** The audio tracks of each video, from `eval-collect.py audio` (.qa/audio.json). */
const audioChecks = readJson<Record<string, AudioState>>(join(dir, "audio.json")) ?? {};

interface Evaluated {
  video: DatasetVideo;
  gt: GroundTruth | null;
  missing: string[];
  voice: VoiceScore[];
  filters: FilterScore | null;
  captions: CaptionScore | null;
  timeline: FeatureTimeline | null;
}

function truthOf(gt: GroundTruth, video: DatasetVideo): { speech: SpeechTruth; caption: Truth } {
  if (video.noSpeech) {
    // Nobody talks: every chunk is a no-speech chunk, every kept line is made up.
    const supports = { cer: false, recall: false, precision: true, translation: false };
    return {
      speech: { speech: [], lines: [], anySpeech: [], precision: true },
      caption: { speech: [], lines: [], anySpeech: [], reference: null, supports },
    };
  }
  const lines = gt.supports.recall ? gt.lines : [];
  const speech = speechIntervals(lines);
  // Where nobody talks: neither the creator (when the track can say so) nor YouTube's
  // automatic captions heard speech.
  const hasAsr = gt.asrSpeech.length > 0;
  const anySpeech: Interval[] | null = hasAsr
    ? [...gt.asrSpeech, ...gt.lines]
    : gt.supports.precision
      ? gt.lines
      : null;
  return {
    speech: { speech, lines, anySpeech, precision: gt.supports.precision },
    caption: {
      speech,
      // Text matching only against the creator's own words.
      lines: gt.source?.kind === "verbatim" ? gt.lines : [],
      anySpeech,
      reference: gt.reference?.lines ?? null,
      supports: gt.supports,
    },
  };
}

function evaluate(video: DatasetVideo): Evaluated {
  const missing: string[] = [];
  const fetched = readJson<FetchedVideo>(join(dir, "gt", `${video.videoId}.json`));
  if (!fetched) missing.push("gt");
  const gt = fetched ? groundTruth(fetched, video.language) : null;
  // A capture of YouTube's AI dub instead of the original audio is refused (audio-track.ts).
  const checked = <T extends { audio?: AudioState }>(file: T | null, what: string): T | null => {
    if (!file) {
      missing.push(what);
      return null;
    }
    const problem = audioProblem(file.audio, audioChecks[video.videoId]);
    if (problem) {
      missing.push(`${what}: ${problem}`);
      return null;
    }
    return file;
  };
  const dry = checked(
    readJson<CaptureFile<FeatureCapture>>(join(dir, "dry", `${video.videoId}.json`)),
    "dry run",
  );
  const whisper = checked(
    readJson<CaptureFile<WhisperCapture>>(join(dir, "whisper", `${video.videoId}.json`)),
    "whisper run",
  );
  const featureCaptures = [
    ...Object.values(dry?.captures ?? {}),
    ...Object.values(whisper?.captures ?? {}),
  ];
  const timeline = featureCaptures.length ? featureTimeline(featureCaptures) : null;
  const t = gt ? truthOf(gt, video) : null;
  const voice =
    timeline && t
      ? [10, 30].map((seconds) =>
          scoreChunks(timeline, simulateChunks(timeline, seconds), t.speech, seconds),
        )
      : [];
  let filters: FilterScore | null = null;
  let captions: CaptionScore | null = null;
  if (whisper && t) {
    const captures = Object.values(whisper.captures).toSorted((a, b) => a.start - b.start);
    filters = scoreFilters(decisionRows(captures, t.caption));
    captions = scoreCaptions(captures, shownCues(captures, flag("--saved")), t.caption);
  }
  return { video, gt, missing, voice, filters, captions, timeline };
}

// ---------- output ----------

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`;
const num = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined ? "-" : x.toFixed(digits);
const ratio = (k: number, n: number) => (n ? `${k}/${n}` : "-");

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? "")].length)));
  return rows
    .map((r) => r.map((cell, i) => cell + " ".repeat(widths[i]! - [...cell].length)).join("  "))
    .join("\n");
}

function supportsText(gt: GroundTruth | null, video: DatasetVideo): string {
  if (video.noSpeech) return "no speech";
  if (!gt) return "-";
  const s = gt.supports;
  return (
    [
      s.cer && "CER",
      s.recall && "recall",
      s.precision && "precision",
      s.translation && "translation",
    ]
      .filter(Boolean)
      .join(",") || "none"
  );
}

const VOICE_HEADER = [
  "A10 talk",
  "A10 lines skipped",
  "A30 talk",
  "A30 lines skipped",
  "A30 BGM skipped",
  "A30 quiet skipped",
  "A30 prec",
];
function voiceCells(v: VoiceScore[]): string[] {
  const [a10, a30] = v;
  if (!a10 || !a30) return VOICE_HEADER.map(() => "-");
  return [
    pct(a10.talkRecall),
    ratio(a10.linesEverSkipped, a10.lines),
    pct(a30.talkRecall),
    ratio(a30.linesEverSkipped, a30.lines),
    ratio(a30.loudSkipped, a30.loudNoSpeech),
    ratio(a30.quietSkipped, a30.quietNoSpeech),
    pct(a30.precision),
  ];
}

const FILTER_HEADER = [
  "B kept speech",
  "B kept nospeech",
  "B dropped speech",
  "B dropped nospeech",
  "B unsure k/d",
];
function filterCells(f: FilterScore | null): string[] {
  if (!f) return FILTER_HEADER.map(() => "-");
  return [
    String(f.keptSpeech),
    String(f.keptNoSpeech),
    String(f.droppedSpeech),
    String(f.droppedNoSpeech),
    `${f.keptUnsure}/${f.droppedUnsure}`,
  ];
}

const CAPTION_HEADER = [
  "C window",
  "C coverage",
  "C CER",
  "C start med/p90",
  "C end med/p90",
  "C outside s",
  "C chrF",
];
function captionCells(c: CaptionScore | null): string[] {
  if (!c) return CAPTION_HEADER.map(() => "-");
  return [
    `${Math.round(c.window.start)}-${Math.round(c.window.end)}`,
    pct(c.coverage),
    c.cer ? num(c.cer.cer) : "-",
    c.start.n ? `${num(c.start.median)}/${num(c.start.absP90)} (${c.start.n})` : "-",
    c.end.n ? `${num(c.end.median)}/${num(c.end.absP90)} (${c.end.n})` : "-",
    c.shownOutsideSpeech === null ? "-" : num(c.shownOutsideSpeech, 0),
    c.chrF === null ? "-" : num(c.chrF, 1),
  ];
}

interface Pool {
  videos: number;
  a10: [number, number];
  a30: [number, number];
  lines10: [number, number];
  lines30: [number, number];
  loud: [number, number];
  quiet: [number, number];
  prec: [number, number];
  kept: [number, number];
  dropped: [number, number];
  coverage: [number, number];
  cer: [number, number];
  chrF: number[];
  starts: number[];
}

function emptyPool(): Pool {
  return {
    videos: 0,
    a10: [0, 0],
    a30: [0, 0],
    lines10: [0, 0],
    lines30: [0, 0],
    loud: [0, 0],
    quiet: [0, 0],
    prec: [0, 0],
    kept: [0, 0],
    dropped: [0, 0],
    coverage: [0, 0],
    cer: [0, 0],
    chrF: [],
    starts: [],
  };
}

function add(pool: Pool, e: Evaluated) {
  pool.videos++;
  const [a10, a30] = e.voice;
  if (a10 && a30) {
    pool.a10[0] += a10.talkSentSeconds;
    pool.a10[1] += a10.talkSeconds;
    pool.a30[0] += a30.talkSentSeconds;
    pool.a30[1] += a30.talkSeconds;
    pool.lines10[0] += a10.linesEverSkipped;
    pool.lines10[1] += a10.lines;
    pool.lines30[0] += a30.linesEverSkipped;
    pool.lines30[1] += a30.lines;
    pool.loud[0] += a30.loudSkipped;
    pool.loud[1] += a30.loudNoSpeech;
    pool.quiet[0] += a30.quietSkipped;
    pool.quiet[1] += a30.quietNoSpeech;
    if (a30.precision !== null) {
      pool.prec[0] += a30.precision * a30.sent;
      pool.prec[1] += a30.sent;
    }
  }
  if (e.filters) {
    pool.kept[0] += e.filters.keptNoSpeech;
    pool.kept[1] += e.filters.keptSpeech + e.filters.keptNoSpeech;
    pool.dropped[0] += e.filters.droppedSpeech;
    pool.dropped[1] += e.filters.keptSpeech + e.filters.droppedSpeech;
  }
  if (e.captions) {
    if (e.captions.coverage !== null) {
      pool.coverage[0] += e.captions.coverage * e.captions.talkSeconds;
      pool.coverage[1] += e.captions.talkSeconds;
    }
    if (e.captions.cer) {
      pool.cer[0] += e.captions.cer.cer * e.captions.cer.refChars;
      pool.cer[1] += e.captions.cer.refChars;
    }
    if (e.captions.chrF !== null) pool.chrF.push(e.captions.chrF);
  }
}

const POOL_HEADER = [
  "group",
  "videos",
  "A10 talk",
  "A10 lines skipped",
  "A30 talk",
  "A30 lines skipped",
  "A30 BGM skipped",
  "A30 quiet skipped",
  "A30 prec",
  "B shown made-up",
  "B speech dropped",
  "C coverage",
  "C CER",
  "C chrF",
];
const share = ([k, n]: [number, number]) => (n ? pct(k / n) : "-");
function poolCells(name: string, p: Pool): string[] {
  return [
    name,
    String(p.videos),
    share(p.a10),
    ratio(p.lines10[0], p.lines10[1]),
    share(p.a30),
    ratio(p.lines30[0], p.lines30[1]),
    ratio(p.loud[0], p.loud[1]),
    ratio(p.quiet[0], p.quiet[1]),
    share(p.prec),
    ratio(p.kept[0], p.kept[1]),
    ratio(p.dropped[0], p.dropped[1]),
    share(p.coverage),
    p.cer[1] ? num(p.cer[0] / p.cer[1]) : "-",
    p.chrF.length ? num(p.chrF.reduce((a, b) => a + b, 0) / p.chrF.length, 1) : "-",
  ];
}

// ---------- commands ----------

const fixtureArgs = option("--write-fixture");
if (fixtureArgs) {
  const i = args.indexOf("--write-fixture");
  const [id, from, to, name] = args.slice(i + 1, i + 5);
  const video = DATASET.find((v) => v.videoId === id);
  if (!video || !from || !to || !name) {
    console.error("usage: --write-fixture <id> <from> <to> <name> (id from src/qa/dataset.ts)");
    process.exit(2);
  }
  const e = evaluate(video);
  if (!e.gt || !e.timeline) {
    console.error(`missing data for ${id}: ${e.missing.join(", ")}`);
    process.exit(1);
  }
  const fixture = fixtureFrom(
    e.timeline,
    truthOf(e.gt, video).speech,
    video,
    Number(from),
    Number(to),
    name,
  );
  mkdirSync("src/test/eval", { recursive: true });
  writeFileSync(join("src/test/eval", `${name}.json`), JSON.stringify(fixture));
  console.log(`wrote src/test/eval/${name}.json: ${fixture.speech.length} speech intervals`);
  process.exit(0);
}

const only = option("--video");
const videos = DATASET.filter((v) => !only || v.videoId === only);
const results = videos.map(evaluate);

if (flag("--dataset")) {
  const rows = [["video", "lang", "category", "voice", "channel", "supports", "flags", "missing"]];
  for (const e of results) {
    rows.push([
      e.video.videoId,
      e.video.language,
      e.video.category,
      e.video.voice,
      e.video.channel,
      supportsText(e.gt, e.video),
      e.gt?.flags.join("; ") ?? "",
      e.missing.join(", "),
    ]);
  }
  console.log(table(rows));
  process.exit(0);
}

console.log(
  "Per video (A = voice detection on simulated chunks starting every second; B = filters; C = captions shown)\n",
);
const rows = [
  ["video", "category", "voice", "supports", ...VOICE_HEADER, ...FILTER_HEADER, ...CAPTION_HEADER],
];
for (const e of results) {
  rows.push([
    e.video.videoId,
    e.video.category,
    e.video.voice,
    supportsText(e.gt, e.video),
    ...voiceCells(e.voice),
    ...filterCells(e.filters),
    ...captionCells(e.captions),
  ]);
}
console.log(table(rows));

for (const key of ["category", "voice", "language"] as const) {
  const groups = new Map<string, Pool>();
  const all = emptyPool();
  for (const e of results) {
    const name = String(e.video[key]);
    const pool = groups.get(name) ?? emptyPool();
    add(pool, e);
    groups.set(name, pool);
    if (key === "category") add(all, e);
  }
  console.log(`\nBy ${key}\n`);
  const out = [
    POOL_HEADER,
    ...[...groups].toSorted(([a], [b]) => a.localeCompare(b)).map(([n, p]) => poolCells(n, p)),
  ];
  if (key === "category") out.push(poolCells("ALL", all));
  console.log(table(out));
}

if (only && results[0]) {
  const e = results[0];
  console.log(
    "\nGround truth:",
    JSON.stringify({ flags: e.gt?.flags, stats: e.gt?.stats, supports: e.gt?.supports }),
  );
  console.log("Voice:", JSON.stringify(e.voice));
  console.log("Filters:", JSON.stringify(e.filters));
  console.log("Captions:", JSON.stringify(e.captions));
}

const jsonOut = option("--json");
if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      results.map(({ timeline: _t, gt, ...rest }) => ({
        ...rest,
        groundTruth: gt && {
          flags: gt.flags,
          stats: gt.stats,
          supports: gt.supports,
          source: gt.source,
        },
      })),
      null,
      1,
    ),
  );
  console.log(`\nwrote ${jsonOut}`);
}
