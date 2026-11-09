// How one chunk's lines are translated: one request, and at most one more, either the whole
// chunk again after a failure that may pass, or only the lines the reply left out. Pure
// logic over injected I/O, so the request sequence can be tested without chrome.*.

import type { TranslateReply } from "@/shared/messages";

export type OkTranslateReply = Extract<TranslateReply, { ok: true }>;

/** Pause before sending a failed translation once more. */
export const TRANSLATION_RETRY_MS = 2000;

export interface TranslationIo<T> {
  /** Sends one request for `lines`; undefined when the background did not answer. */
  send(lines: T[]): Promise<TranslateReply | undefined>;
  /** False once the chunk was cancelled (seek, other video): stop and send nothing more. */
  alive(): boolean;
  wait(ms: number): Promise<void>;
  /** Puts a reply's translations on `lines` (all but `reply.missing`). */
  apply(lines: T[], reply: OkTranslateReply): void;
  /** Whether lines left out may be asked for (not when translation is paused). */
  mayAskAgain(): boolean;
  onRetry?(error: string): void;
}

export type TranslationOutcome<T> =
  | { kind: "cancelled" }
  /** No usable reply: the last failure, or undefined when the background did not answer. */
  | { kind: "failed"; reply: Exclude<TranslateReply, OkTranslateReply> | undefined }
  /** Translated; `missing` are the lines no reply translated. */
  | { kind: "done"; missing: T[] };

export async function translateWithRetry<T>(
  lines: T[],
  io: TranslationIo<T>,
): Promise<TranslationOutcome<T>> {
  let extraRequest = true;
  let reply = await io.send(lines);
  if (!io.alive()) return { kind: "cancelled" };
  if (reply && !reply.ok && reply.retryable) {
    extraRequest = false;
    io.onRetry?.(reply.error);
    await io.wait(TRANSLATION_RETRY_MS);
    if (!io.alive()) return { kind: "cancelled" };
    reply = await io.send(lines);
    if (!io.alive()) return { kind: "cancelled" };
  }
  if (!reply?.ok) return { kind: "failed", reply };
  io.apply(lines, reply);
  let missing = reply.missing.map((i) => lines[i]).filter((line) => line !== undefined);
  if (missing.length && extraRequest && io.mayAskAgain()) {
    const again = await io.send(missing);
    if (!io.alive()) return { kind: "cancelled" };
    if (again?.ok) {
      io.apply(missing, again);
      missing = again.missing.map((i) => missing[i]).filter((line) => line !== undefined);
    }
  }
  return { kind: "done", missing };
}
