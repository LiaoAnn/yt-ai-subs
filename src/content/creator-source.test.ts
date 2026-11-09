import { describe, expect, it } from "vitest";
import type { Cue } from "@/shared/captions";
import { PAGE_MESSAGE_TAG, type CreatorCaptionsMessage } from "@/shared/messages";
import {
  PENDING_WAIT_MS,
  advanceDecidingMs,
  decideSource,
  linesForChunk,
  mergeCachedTranslations,
} from "./creator-source";

const SETTINGS = { translate: true, targetLanguage: "zh-TW", sourceLanguage: "ja" } as const;

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
    expect(decideSource(undefined, 0, SETTINGS).kind).toBe("deciding");
    // 5 s: the page script answers within about a second when it saw the player response.
    expect(decideSource(reply({ status: "unknown" }), 4999, SETTINGS).kind).toBe("deciding");
    expect(decideSource(undefined, 5000, SETTINGS).kind).toBe("whisper");
    expect(
      decideSource(reply({ status: "pending", languageCode: "ja" }), 5000, SETTINGS).kind,
    ).toBe("deciding");
    expect(
      decideSource(reply({ status: "pending", languageCode: "ja" }), PENDING_WAIT_MS, SETTINGS)
        .kind,
    ).toBe("whisper");
  });

  it("uses Whisper without a creator track or when fetching it failed", () => {
    expect(decideSource(reply({ status: "none" }), 0, SETTINGS).kind).toBe("whisper");
    expect(decideSource(reply({ status: "failed", reason: "x" }), 0, SETTINGS)).toEqual({
      kind: "whisper",
      reason: "x",
    });
  });

  it("spends nothing when the creator track is in the target language", () => {
    expect(
      decideSource(
        reply({ status: "target", languageCode: "zh-Hant", name: "中文（繁體）" }),
        0,
        SETTINGS,
      ),
    ).toEqual({
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
      SETTINGS,
    );
    expect(used.kind).toBe("creator");
    if (used.kind === "creator") {
      expect(used.languageCode).toBe("ja");
      expect(used.cues[0]).toEqual({ start: 0.4, end: 2.9, original: "手で書いた0番目の台詞" });
    }
    const copied = decideSource(
      reply({ status: "fetched", languageCode: "ja", creator: asr, asr }),
      0,
      SETTINGS,
    );
    expect(copied.kind).toBe("whisper");
    // No automatic track to compare with: trusted.
    expect(
      decideSource(
        reply({ status: "fetched", languageCode: "ja", creator: handMade, asr: null }),
        0,
        SETTINGS,
      ).kind,
    ).toBe("creator");
  });
});

describe("decideSource with debugForceWhisper", () => {
  const forced = { ...SETTINGS, debugCapture: true, debugForceWhisper: true };

  it("uses Whisper at once, even with a usable creator track", () => {
    const fetched = reply({ status: "fetched", languageCode: "ja" });
    expect(decideSource(fetched, 0, forced)).toEqual({
      kind: "whisper",
      reason: "debugForceWhisper",
    });
    expect(decideSource(undefined, 0, forced).kind).toBe("whisper");
    expect(decideSource(reply({ status: "target", languageCode: "zh-Hant" }), 0, forced).kind).toBe(
      "whisper",
    );
  });

  it("needs debugCapture", () => {
    expect(decideSource(undefined, 0, { ...forced, debugCapture: false }).kind).toBe("deciding");
  });
});

describe("decideSource after a settings change", () => {
  it("drops a target-language creator track the settings no longer want", () => {
    const target = reply({ status: "target", languageCode: "zh-Hant", name: "中文" });
    expect(decideSource(target, 0, SETTINGS).kind).toBe("target");
    expect(decideSource(target, 0, { ...SETTINGS, translate: false }).kind).toBe("whisper");
    expect(decideSource(target, 0, { ...SETTINGS, targetLanguage: "en" }).kind).toBe("whisper");
  });

  it("drops a spoken-language creator track in another language than the setting", () => {
    const handMade = events(["一行目です", "二行目です"]);
    const fetched = reply({ status: "fetched", languageCode: "ja", creator: handMade, asr: null });
    expect(decideSource(fetched, 0, SETTINGS).kind).toBe("creator");
    expect(decideSource(fetched, 0, { ...SETTINGS, sourceLanguage: "ko" }).kind).toBe("whisper");
    expect(decideSource(fetched, 0, { ...SETTINGS, sourceLanguage: "auto" }).kind).toBe("creator");
    // Translation off: the creator's lines are shown untranslated.
    expect(decideSource(fetched, 0, { ...SETTINGS, translate: false }).kind).toBe("creator");
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

describe("advanceDecidingMs", () => {
  it("counts wall time between ticks, at most one tick's worth, and nothing during ads", () => {
    expect(advanceDecidingMs(0, 0, 10_000, false)).toBe(0); // the first tick starts the clock
    // Extra ticks within a second (events) add only the time that passed.
    expect(advanceDecidingMs(0, 10_000, 10_050, false)).toBe(50);
    expect(advanceDecidingMs(50, 10_050, 11_000, false)).toBe(1000);
    // A throttled background tab ticking late does not jump the clock.
    expect(advanceDecidingMs(1000, 11_000, 20_000, false)).toBe(2000);
    expect(advanceDecidingMs(1000, 11_000, 12_000, true)).toBe(1000);
  });
});
