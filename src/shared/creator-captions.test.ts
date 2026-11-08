import { describe, expect, it } from "vitest";
import type { Json3Event } from "./captions";
import {
  analyzeCreatorTrack,
  editDistance,
  json3Lines,
  languageMatches,
  normalizeText,
  readCaptionTracks,
  sourceTracks,
  targetTrack,
  type CaptionLine,
  type CaptionTrackInfo,
} from "./creator-captions";

const track = (languageCode: string, kind?: string): CaptionTrackInfo => ({
  languageCode,
  ...(kind ? { kind } : {}),
  vssId: `${kind === "asr" ? "a" : ""}.${languageCode}`,
  name: languageCode,
  baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}`,
});

describe("readCaptionTracks", () => {
  it("keeps usable entries, reads both name shapes and skips ours", () => {
    const tracks = readCaptionTracks(
      [
        { languageCode: "ja", vssId: ".ja", baseUrl: "u1", name: { simpleText: "日本語" } },
        {
          languageCode: "ja",
          vssId: "a.ja",
          kind: "asr",
          baseUrl: "u2",
          name: { runs: [{ text: "自動" }] },
        },
        { languageCode: "zh-TW", vssId: ".zh-TW.ytaisubs", baseUrl: "u3" },
        { languageCode: "ko", vssId: ".ko" }, // no baseUrl
        "garbage",
      ],
      (vssId) => vssId.endsWith(".ytaisubs"),
    );
    expect(tracks).toEqual([
      { languageCode: "ja", vssId: ".ja", baseUrl: "u1", name: "日本語" },
      { languageCode: "ja", vssId: "a.ja", kind: "asr", baseUrl: "u2", name: "自動" },
    ]);
    expect(readCaptionTracks(undefined, () => false)).toEqual([]);
  });
});

describe("track choice", () => {
  it("matches Traditional Chinese codes to a zh-TW target, never Simplified or plain zh", () => {
    for (const code of ["zh-Hant", "zh-TW", "zh-HK", "zh-Hant-TW"]) {
      expect(languageMatches(code, "zh-TW")).toBe(true);
    }
    for (const code of ["zh-Hans", "zh", "zh-CN", "ja"]) {
      expect(languageMatches(code, "zh-TW")).toBe(false);
    }
    expect(languageMatches("en-US", "en")).toBe(true);
  });

  it("uses a creator track in the target language, never an automatic one", () => {
    // Il3rOIG-6pg lists zh-Hans, zh-Hant, en-US, ja, ja (asr), ko.
    const tracks = [
      track("zh-Hans"),
      track("zh-Hant"),
      track("en-US"),
      track("ja"),
      track("ja", "asr"),
      track("ko"),
    ];
    expect(targetTrack(tracks, "zh-TW")?.languageCode).toBe("zh-Hant");
    expect(targetTrack(tracks, "en")?.languageCode).toBe("en-US");
    expect(targetTrack([track("zh-Hans"), track("ja")], "zh-TW")).toBeNull();
    expect(targetTrack([track("en", "asr")], "en")).toBeNull();
  });

  it("finds the spoken-language creator track and its automatic twin", () => {
    const tracks = [track("zh-Hant"), track("ja"), track("ja", "asr")];
    expect(sourceTracks(tracks, "ja")).toEqual({ creator: tracks[1], asr: tracks[2] });
    // auto: the spoken language is the automatic track's
    expect(sourceTracks(tracks, "auto")?.creator.languageCode).toBe("ja");
    expect(sourceTracks(tracks, "ko")).toBeNull();
    expect(sourceTracks([track("ko")], "ko")).toEqual({ creator: track("ko"), asr: null });
    // Only an automatic track: nothing to use.
    expect(sourceTracks([track("ja", "asr")], "ja")).toBeNull();
    expect(sourceTracks([track("ja")], "auto")).toBeNull();
  });
});

describe("json3Lines", () => {
  it("joins segments, skips empty events and ends open events at the next one", () => {
    const events: Json3Event[] = [
      { tStartMs: 2000, dDurationMs: 0, segs: [{ utf8: "次" }] },
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "こん" }, { utf8: "にちは\n世界" }] },
      { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: "\n" }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "最後" }] },
    ];
    expect(json3Lines(events)).toEqual([
      { start: 0, end: 1.5, text: "こんにちは 世界" },
      { start: 2, end: 4, text: "次" },
      { start: 4, end: 5, text: "最後" },
    ]);
  });
});

describe("text comparison", () => {
  it("ignores spaces, punctuation and width", () => {
    expect(normalizeText("こんにちは、 世界！ ＡＢ")).toBe("こんにちは世界ab");
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});

/** 60 lines of 3 s each, with distinct text. */
function asrLines(): CaptionLine[] {
  const words =
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
  return Array.from({ length: 60 }, (_, i) => ({
    start: i * 3,
    end: i * 3 + 2.5,
    text: `${words[i % words.length]}${words[(i * 7) % words.length]}${words[(i * 11) % words.length]}です`,
  }));
}

describe("analyzeCreatorTrack", () => {
  it("rejects a copy of the automatic track (same text, same start times)", () => {
    const asr = asrLines();
    const copy = asr.map((line) => ({ ...line }));
    copy[3] = { ...copy[3]!, text: "ちがう" }; // one fixed word does not make it hand-made
    const result = analyzeCreatorTrack(copy, asr);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("副本");
    expect(result.p90Offset).toBe(0);
    expect(result.cer).toBeLessThan(0.1);
  });

  it("accepts hand-made text even when its timing is YouTube's alignment", () => {
    const asr = asrLines();
    // Same starts, but every fourth line reworded (about 0.2 CER): the text is the creator's.
    const creator = asr.map((line, i) =>
      i % 3 === 0 ? { ...line, text: "まったく別の言葉" } : { ...line },
    );
    const result = analyzeCreatorTrack(creator, asr);
    expect(result.cer).toBeGreaterThan(0.15);
    expect(result.usable).toBe(true);
  });

  it("accepts near-verbatim text with its own timing", () => {
    const asr = asrLines();
    const creator = asr.map((line) => ({ ...line, start: line.start + 0.4, end: line.end + 0.4 }));
    const result = analyzeCreatorTrack(creator, asr);
    expect(result.cer).toBe(0);
    expect(result.medianOffset).toBeCloseTo(0.4);
    expect(result.usable).toBe(true);
  });

  it("rejects a track that covers only part of the speech (summary cards)", () => {
    const asr = asrLines();
    const creator = [
      { start: 0, end: 30, text: "今日の内容" },
      { start: 150, end: 160, text: "まとめ" },
    ];
    const result = analyzeCreatorTrack(creator, asr);
    expect(result.coverage).toBeLessThan(0.5);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("部分");
  });

  it("trusts a creator track when there is no automatic one, never an empty one", () => {
    expect(analyzeCreatorTrack(asrLines(), null).usable).toBe(true);
    expect(analyzeCreatorTrack([], asrLines()).usable).toBe(false);
  });

  it("does not count caption cards in the automatic track as speech to cover", () => {
    const asr = [
      ...asrLines().slice(0, 10),
      ...Array.from({ length: 30 }, (_, i) => ({
        start: 30 + i * 3,
        end: 32 + i * 3,
        text: "[音楽]",
      })),
    ];
    const creator = asrLines()
      .slice(0, 10)
      .map((line) => ({
        ...line,
        start: line.start + 0.5,
        end: line.end + 0.5,
        text: `「${line.text}」`,
      }));
    expect(analyzeCreatorTrack(creator, asr)).toMatchObject({ usable: true, coverage: 1 });
  });
});
