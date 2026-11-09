import { describe, expect, it } from "vitest";
import type { TranslateReply } from "@/shared/messages";
import {
  TRANSLATION_RETRY_MS,
  translateWithRetry,
  type TranslationIo,
} from "./translation-attempts";

const quota = { whisper: "ok", chat: "ok" } as const;

function ok(lines: string[], missing: number[] = []): TranslateReply {
  return {
    ok: true,
    lines,
    missing,
    totalTokens: 100,
    terms: {},
    latencyMs: 1,
    waitedMs: 0,
    quota,
  };
}

const failed = (retryable: boolean): TranslateReply => ({
  ok: false,
  error: "翻譯失敗 500",
  aborted: false,
  ...(retryable ? { retryable: true } : {}),
});

/** Records what was sent, answers from `replies` in order, applies onto `out`. */
function harness(replies: (TranslateReply | undefined)[], opts: { alive?: () => boolean } = {}) {
  const sent: string[][] = [];
  const waits: number[] = [];
  const out = new Map<string, string>();
  const io: TranslationIo<string> = {
    send: async (lines) => {
      sent.push(lines);
      return replies.shift();
    },
    alive: opts.alive ?? (() => true),
    wait: async (ms) => {
      waits.push(ms);
    },
    apply: (lines, reply) => {
      const missing = new Set(reply.ok ? reply.missing : []);
      lines.forEach((line, i) => {
        if (reply.ok && !missing.has(i)) out.set(line, reply.lines[i]!);
      });
    },
    mayAskAgain: () => true,
  };
  return { io, sent, waits, out };
}

describe("translateWithRetry", () => {
  it("sends once when the reply is complete", async () => {
    const h = harness([ok(["一", "二"])]);
    expect(await translateWithRetry(["a", "b"], h.io)).toEqual({ kind: "done", missing: [] });
    expect(h.sent).toEqual([["a", "b"]]);
    expect([...h.out]).toEqual([
      ["a", "一"],
      ["b", "二"],
    ]);
  });

  it("sends the whole chunk once more after a retryable failure, after a pause", async () => {
    const h = harness([failed(true), ok(["一", "二"])]);
    expect(await translateWithRetry(["a", "b"], h.io)).toEqual({ kind: "done", missing: [] });
    expect(h.sent).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(h.waits).toEqual([TRANSLATION_RETRY_MS]);
  });

  it("does not retry a failure that will not pass, nor a second failure", async () => {
    const once = harness([failed(false), ok(["一"])]);
    expect((await translateWithRetry(["a"], once.io)).kind).toBe("failed");
    expect(once.sent).toHaveLength(1);
    const twice = harness([failed(true), failed(true), ok(["一"])]);
    expect((await translateWithRetry(["a"], twice.io)).kind).toBe("failed");
    expect(twice.sent).toHaveLength(2);
  });

  it("asks for the lines a reply left out, alone", async () => {
    const h = harness([ok(["一", "b", "三"], [1]), ok(["二"])]);
    expect(await translateWithRetry(["a", "b", "c"], h.io)).toEqual({ kind: "done", missing: [] });
    expect(h.sent).toEqual([["a", "b", "c"], ["b"]]);
    expect(h.out.get("b")).toBe("二");
  });

  it("sends at most one extra request: left-out lines after a retry stay missing", async () => {
    const h = harness([failed(true), ok(["一", "b"], [1]), ok(["二"])]);
    expect(await translateWithRetry(["a", "b"], h.io)).toEqual({ kind: "done", missing: ["b"] });
    expect(h.sent).toHaveLength(2);
  });

  it("reports lines the extra request left out again, and none when it fails", async () => {
    const again = harness([ok(["一", "b", "c"], [1, 2]), ok(["二", "c"], [1])]);
    expect(await translateWithRetry(["a", "b", "c"], again.io)).toEqual({
      kind: "done",
      missing: ["c"],
    });
    const fails = harness([ok(["一", "b"], [1]), failed(true)]);
    expect(await translateWithRetry(["a", "b"], fails.io)).toEqual({
      kind: "done",
      missing: ["b"],
    });
    expect(fails.sent).toHaveLength(2);
  });

  it("does not ask for left-out lines while translation is paused", async () => {
    const h = harness([ok(["一", "b"], [1])]);
    h.io.mayAskAgain = () => false;
    expect(await translateWithRetry(["a", "b"], h.io)).toEqual({ kind: "done", missing: ["b"] });
    expect(h.sent).toHaveLength(1);
  });

  it("sends nothing more once the chunk is cancelled during the pause", async () => {
    let alive = true;
    const h = harness([failed(true), ok(["一"])], { alive: () => alive });
    h.io.wait = async () => {
      alive = false;
    };
    expect(await translateWithRetry(["a"], h.io)).toEqual({ kind: "cancelled" });
    expect(h.sent).toHaveLength(1);
  });
});
