// Regression check of voice detection on committed stretches of the evaluation set
// (src/test/eval/*.json: voice features per 20 ms and where people talk, no text). The
// floors are the numbers current main reached when the fixtures were written; a change may
// raise them (then raise the floors too) but must not fall below them.
import { describe, expect, it } from "vitest";
import { scoreFixture, type EvalFixture } from "./fixture";

interface Floor {
  /** Share of talk seconds in sent chunks, 10 s and 30 s chunks. */
  talk10?: number;
  talk30?: number;
  /** Most lines allowed to fall in some skipped chunk, 10 s and 30 s chunks. */
  maxSkippedLines10?: number;
  maxSkippedLines30?: number;
  /** Share of music/sound-only 10 s and 30 s chunks that must be skipped. */
  loudSkipped10?: number;
  loudSkipped30?: number;
}

/**
 * Floors per fixture (name → floor): what main reached, rounded down. Written on 2026-11-08
 * (voice.ts as of PR #1); recall floors raised and music floors lowered with the syllable
 * rule (voice detection leans towards sending; the filters after Whisper catch made-up text,
 * see AGENTS.md "Voice activity"). Raise a floor when a change improves it.
 */
const FLOORS: Record<string, Floor> = {
  // cth3M1iavGM 0:30–1:20, the low male voice of PR #1 (weak labels: YouTube's automatic track)
  "low-male-voice": { talk10: 1, talk30: 1, maxSkippedLines10: 0, maxSkippedLines30: 0 },
  // LKTOWTc9l1E 1:40–2:50, VTuber clips: high female voices, sound effects
  "high-female-voices": { talk10: 1, talk30: 1, maxSkippedLines10: 0, maxSkippedLines30: 0 },
  // _xhw8bUhWOk 0:00–1:10, variety talk (several speakers) over BGM
  "talk-over-bgm": { talk10: 1, talk30: 1, maxSkippedLines10: 0, maxSkippedLines30: 0 },
  // LHZgl2pbY7Q 0:00–2:00, a silent vlog with BGM: nearly all of it is sent (3 of 98 10 s
  // chunks skipped; 15 before the syllable rule)
  "bgm-only-silent-vlog": { loudSkipped10: 0.03, loudSkipped30: 0 },
  // Il3rOIG-6pg 6:20–8:00, music after the talk ends: 19 of 47 10 s chunks skipped (30 before)
  "music-after-talk": { loudSkipped10: 0.4, loudSkipped30: 0 },
};

const fixtures = Object.values(
  import.meta.glob<EvalFixture>("../test/eval/*.json", { eager: true, import: "default" }),
);

describe("evaluation fixtures", () => {
  it("has a floor for every fixture", () => {
    expect(fixtures.map((f) => f.name).toSorted()).toEqual(Object.keys(FLOORS).toSorted());
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} (${fixture.videoId} ${fixture.from}–${fixture.to} s) does not regress`, () => {
      const floor = FLOORS[fixture.name] ?? {};
      const [a10, a30] = scoreFixture(fixture);
      if (floor.talk10 !== undefined) expect(a10!.talkRecall).toBeGreaterThanOrEqual(floor.talk10);
      if (floor.talk30 !== undefined) expect(a30!.talkRecall).toBeGreaterThanOrEqual(floor.talk30);
      if (floor.maxSkippedLines10 !== undefined)
        expect(a10!.linesEverSkipped).toBeLessThanOrEqual(floor.maxSkippedLines10);
      if (floor.maxSkippedLines30 !== undefined)
        expect(a30!.linesEverSkipped).toBeLessThanOrEqual(floor.maxSkippedLines30);
      if (floor.loudSkipped10 !== undefined) {
        expect(a10!.loudNoSpeech).toBeGreaterThan(0);
        expect(a10!.loudSkipped / a10!.loudNoSpeech).toBeGreaterThanOrEqual(floor.loudSkipped10);
      }
      if (floor.loudSkipped30 !== undefined) {
        expect(a30!.loudNoSpeech).toBeGreaterThan(0);
        expect(a30!.loudSkipped / a30!.loudNoSpeech).toBeGreaterThanOrEqual(floor.loudSkipped30);
      }
    });
  }
});
