import { describe, expect, it } from "vitest";
import type { Cue } from "@/shared/captions";
import { PAGE_MESSAGE_TAG, type CreatorCaptionsMessage } from "@/shared/messages";
import {
  PENDING_WAIT_MS,
  UNKNOWN_WAIT_MS,
  decideSource,
  linesForChunk,
  mergeCachedTranslations,
} from "./creator-source";

const reply = (extra: Partial<CreatorCaptionsMessage>): CreatorCaptionsMessage => ({
  [PAGE_MESSAGE_TAG]: true,
  type: "creator-captions",
  videoId: "vid",
  status: "unknown",
  ...extra,
});

const events = (texts: string[], startMs = 0, stepMs = 3000) =>
  texts.map((text, i) => ({
    tStartMs: startMs + i * stepMs,
    dDurationMs: 2500,
    segs: [{ utf8: text }],
  }));

describe("decideSource", () => {
  it("waits for the page script, then gives up and uses Whisper", () => {
    expect(decideSource(undefined, 0).kind).toBe("deciding");
    expect(decideSource(reply({ status: "unknown" }), UNKNOWN_WAIT_MS - 1).kind).toBe("deciding");
    expect(decideSource(undefined, UNKNOWN_WAIT_MS).kind).toBe("whisper");
    expect(decideSource(reply({ status: "pending" }), UNKNOWN_WAIT_MS).kind).toBe("deciding");
    expect(decideSource(reply({ status: "pending" }), PENDING_WAIT_MS).kind).toBe("whisper");
  });

  it("uses Whisper without a creator track or when fetching it failed", () => {
    expect(decideSource(reply({ status: "none" }), 0).kind).toBe("whisper");
    expect(decideSource(reply({ status: "failed", reason: "x" }), 0)).toEqual({
      kind: "whisper",
      reason: "x",
    });
  });

  it("spends nothing when the creator track is in the target language", () => {
    expect(decideSource(reply({ status: "target", name: "中文（繁體）" }), 0)).toEqual({
      kind: "target",
      name: "中文（繁體）",
    });
  });

  it("uses a hand-made creator track and rejects a copy of the automatic one", () => {
    const asr = events(Array.from({ length: 20 }, (_, i) => `自動の${i}行目です`));
    const handMade = events(
      Array.from({ length: 20 }, (_, i) => `手で書いた${i}番目の台詞`),
      400,
    );
    const used = decideSource(
      reply({ status: "fetched", languageCode: "ja", name: "日本語", creator: handMade, asr }),
      0,
    );
    expect(used.kind).toBe("creator");
    if (used.kind === "creator") {
      expect(used.languageCode).toBe("ja");
      expect(used.cues[0]).toEqual({ start: 0.4, end: 2.9, original: "手で書いた0番目の台詞" });
    }
    const copied = decideSource(
      reply({ status: "fetched", languageCode: "ja", creator: asr, asr }),
      0,
    );
    expect(copied.kind).toBe("whisper");
    // No automatic track to compare with: trusted.
    expect(decideSource(reply({ status: "fetched", creator: handMade, asr: null }), 0).kind).toBe(
      "creator",
    );
  });
});

describe("mergeCachedTranslations", () => {
  it("restores cached translations by start and text, leaves the rest untranslated", () => {
    const lines: Cue[] = [
      { start: 1, end: 2, original: "a" },
      { start: 3, end: 4, original: "b" },
    ];
    const merged = mergeCachedTranslations(lines, [
      { start: 1, end: 2, original: "a", translation: "甲" },
      { start: 3, end: 4, original: "changed", translation: "乙" },
    ]);
    expect(merged).toEqual([
      { start: 1, end: 2, original: "a", translation: "甲" },
      { start: 3, end: 4, original: "b" },
    ]);
    expect(merged[1]).not.toBe(lines[1]);
  });
});

describe("linesForChunk", () => {
  it("takes untranslated lines overlapping the chunk that no other chunk took", () => {
    const cues: Cue[] = [
      { start: 8, end: 11, original: "on screen at the seek" },
      { start: 12, end: 13, original: "done", translation: "好了" },
      { start: 14, end: 15, original: "taken" },
      { start: 20, end: 22, original: "mine" },
      { start: 30, end: 31, original: "next chunk" },
    ];
    const taken = new Set([cues[2]!]);
    expect(linesForChunk(cues, 10, 30, taken).map((cue) => cue.original)).toEqual([
      "on screen at the seek",
      "mine",
    ]);
  });
});
