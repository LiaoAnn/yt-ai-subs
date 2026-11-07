// Pure helpers for the page script.

export type Range = [start: number, end: number];

/** Ignore slivers smaller than this (seconds) when diffing buffered ranges. */
const MIN_SPAN = 0.02;

/** The time span that exists in `after` but not in `before`, or null. */
export function newSpan(after: readonly Range[], before: readonly Range[]): Range | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [start, end] of after) {
    let parts: Range[] = [[start, end]];
    for (const [bs, be] of before) {
      parts = parts.flatMap(([x, y]): Range[] => {
        if (be <= x || bs >= y) return [[x, y]];
        const out: Range[] = [];
        if (bs > x) out.push([x, bs]);
        if (be < y) out.push([be, y]);
        return out;
      });
    }
    for (const [x, y] of parts) {
      if (y - x > MIN_SPAN) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, y);
      }
    }
  }
  return lo < hi ? [lo, hi] : null;
}
