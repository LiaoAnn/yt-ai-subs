// Where a video's caption lines come from (pure logic): Whisper, the creator's own track in
// the spoken language (only translated), or nothing at all because the creator's track in
// the target language is shown instead. The page script reports the tracks
// (src/page/creator-hooks.ts); the checks are in src/shared/creator-captions.ts.

import type { Cue } from "@/shared/captions";
import {
  analyzeCreatorTrack,
  describeAnalysis,
  json3Lines,
  linesToCues,
} from "@/shared/creator-captions";
import type { CreatorCaptionsMessage } from "@/shared/messages";

export type CaptionSource =
  | { kind: "deciding" }
  | { kind: "whisper"; reason: string }
  /** The creator's track in the target language is shown: spend nothing. */
  | { kind: "target"; name: string }
  /** The creator's spoken-language lines, untranslated. */
  | { kind: "creator"; languageCode: string; cues: Cue[]; summary: string };

/** No word from the page script about the video this long (ad-free): use Whisper. */
export const UNKNOWN_WAIT_MS = 15_000;
/** The creator track still not fetched after this long: use Whisper. */
export const PENDING_WAIT_MS = 30_000;

/**
 * The source for a video from the page script's latest reply, or "deciding" while it is
 * worth waiting. `waitedMs` is the ad-free time spent deciding so far.
 */
export function decideSource(
  reply: CreatorCaptionsMessage | undefined,
  waitedMs: number,
): CaptionSource {
  const status = reply?.status ?? "unknown";
  switch (status) {
    case "none":
      return { kind: "whisper", reason: "沒有創作者上傳的字幕" };
    case "failed":
      return { kind: "whisper", reason: reply?.reason || "抓不到創作者字幕" };
    case "target":
      return { kind: "target", name: reply?.name || reply?.languageCode || "" };
    case "fetched": {
      const creator = json3Lines(reply?.creator ?? []);
      const asr = reply?.asr ? json3Lines(reply.asr) : null;
      const analysis = analyzeCreatorTrack(creator, asr);
      const summary = `${reply?.languageCode} "${reply?.name}": ${describeAnalysis(analysis)}`;
      if (!analysis.usable) return { kind: "whisper", reason: `${analysis.reason}（${summary}）` };
      return {
        kind: "creator",
        languageCode: reply?.languageCode ?? "",
        cues: linesToCues(creator),
        summary,
      };
    }
    case "pending":
      return waitedMs >= PENDING_WAIT_MS
        ? { kind: "whisper", reason: "等不到創作者字幕" }
        : { kind: "deciding" };
    default:
      return waitedMs >= UNKNOWN_WAIT_MS
        ? { kind: "whisper", reason: "頁面腳本沒有回報字幕軌" }
        : { kind: "deciding" };
  }
}

const cueKey = (cue: Pick<Cue, "start" | "original">) => `${cue.start.toFixed(2)}\n${cue.original}`;

/**
 * The creator's lines with the translations a cache entry holds for them. Lines the entry
 * does not have (not translated yet) stay untranslated.
 */
export function mergeCachedTranslations(lines: readonly Cue[], cached: readonly Cue[]): Cue[] {
  const translations = new Map<string, string>();
  for (const cue of cached) if (cue.translation) translations.set(cueKey(cue), cue.translation);
  return lines.map((line) => {
    const translation = translations.get(cueKey(line));
    return translation ? { ...line, translation } : { ...line };
  });
}

/**
 * Creator lines a translation chunk takes: those overlapping it (a line already on screen
 * at a start or seek is included), not translated yet and not taken by another chunk.
 */
export function linesForChunk(
  cues: readonly Cue[],
  start: number,
  end: number,
  taken: ReadonlySet<Cue>,
): Cue[] {
  return cues.filter(
    (cue) =>
      cue.start < end && cue.end > start + 0.05 && cue.translation === undefined && !taken.has(cue),
  );
}
