// Re-runs segmentation on saved debug captures and prints timing statistics, without
// calling the API. Captures come from the debugCapture setting (src/content/debug-capture.ts),
// exported from the popup page as JSON. Keep them out of git: they hold other people's
// transcripts. See the test-extension-in-browser skill.
//
//   node scripts/qa-replay.ts <file-or-dir>...            summary per video and overall
//   node scripts/qa-replay.ts --cues <file-or-dir>...     also every line with its timing
//   node scripts/qa-replay.ts --saved <file-or-dir>...    use the cues saved at capture time
//   node scripts/qa-replay.ts --json <file-or-dir>...     print the lines per chunk as JSON
//                                                         (video timeline), e.g. to re-translate
//
// A file holds one capture, an array of captures, or an object of them (as exported).
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Cue } from "../src/shared/captions.ts";
import { evaluateCues, replayCues, summarize, type CaptureLike } from "../src/qa/timing-eval.ts";

interface Capture extends CaptureLike {
  cues: Cue[];
}

const args = process.argv.slice(2);
const showCues = args.includes("--cues");
const useSaved = args.includes("--saved");
const asJson = args.includes("--json");
const paths = args.filter((a) => !a.startsWith("--"));
if (!paths.length) {
  console.error("usage: node scripts/qa-replay.ts [--cues] [--saved] <file-or-dir>...");
  process.exit(2);
}

function isCapture(value: unknown): value is Capture {
  return (
    typeof value === "object" &&
    value !== null &&
    "envelope" in value &&
    "raw" in value &&
    "videoId" in value
  );
}

async function load(path: string): Promise<Capture[]> {
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path)).filter((n) => n.endsWith(".json")).toSorted();
    return (await Promise.all(names.map((n) => load(join(path, n))))).flat();
  }
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  const values = Array.isArray(json)
    ? json
    : isCapture(json)
      ? [json]
      : Object.values(json as object);
  return values.filter(isCapture);
}

const captures = (await Promise.all(paths.map(load))).flat();
const cuesOf = (c: CaptureLike) =>
  useSaved
    ? (c as Capture).cues.map((cue) => ({
        ...cue,
        start: cue.start - c.start,
        end: cue.end - c.start,
      }))
    : replayCues(c);

if (asJson) {
  const chunks = captures
    .toSorted((a, b) => a.videoId.localeCompare(b.videoId) || a.start - b.start)
    .map((c) => ({
      videoId: c.videoId,
      start: c.start,
      end: c.end,
      cues: cuesOf(c)
        .map((cue) => ({ ...cue, start: c.start + cue.start, end: c.start + cue.end }))
        // what was shown: lines after a trimmed end were sent again with the next chunk
        .filter((cue) => cue.start < c.end - 0.05),
    }));
  console.log(JSON.stringify(chunks));
  process.exit(0);
}

const byVideo = new Map<string, Capture[]>();
for (const capture of captures) {
  byVideo.set(capture.videoId, [...(byVideo.get(capture.videoId) ?? []), capture]);
}
const fmt = (x: number | null) => (x === null ? "   -  " : (x >= 0 ? "+" : "") + x.toFixed(2));
for (const [videoId, list] of byVideo) {
  const sorted = list.toSorted((a, b) => a.start - b.start);
  console.log(`\n=== ${videoId}: ${JSON.stringify(summarize(sorted, cuesOf))}`);
  if (!showCues) continue;
  for (const capture of sorted) {
    console.log(
      `--- chunk ${capture.start.toFixed(2)}–${capture.end.toFixed(2)} (sent ${capture.sentSeconds.toFixed(1)} s)`,
    );
    for (const t of evaluateCues(capture, cuesOf(capture))) {
      const at = capture.start + t.cue.start;
      console.log(
        `${at.toFixed(2).padStart(8)} ${t.duration.toFixed(2).padStart(5)}s start${fmt(t.startError)} end${fmt(t.endError)} loud${t.loudnessAboveFloor.toFixed(0).padStart(3)} ${t.cue.original}`,
      );
    }
  }
}
console.log(`\n=== all: ${JSON.stringify(summarize(captures, cuesOf))}`);
