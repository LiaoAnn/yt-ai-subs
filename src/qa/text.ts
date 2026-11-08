// Text measures for the offline evaluation: caption cleaning, the normalisation applied
// before comparing texts, character error rate and chrF. Pure functions, plain Node.

/**
 * Text of a creator caption line that is not speech: caption cards in brackets
 * (`[해맑게 저장하는 잠용이]`, `(감격)`, `【…】`, `（…）`), sound notes (`[音楽]`, `♪`) and
 * speaker labels (`리원 / …`, `[인모] …`, `name：…`).
 */
const BRACKETED =
  /\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）|【[^】]*】|〔[^〕]*〕|<[^>]*>|≪[^≫]*≫|《[^》]*》/g;
const MUSIC = /[♪♫♬～〜]+/g;
/** A short name before a slash or full-width colon at the start of a line. */
const SPEAKER_LABEL = /^\s*\p{L}{1,8}\s*[/／:：]\s*/u;

/** Creator caption text without cards, notes and speaker labels. */
export function speechText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(SPEAKER_LABEL, "").replace(BRACKETED, " ").replace(MUSIC, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a creator line holds nothing but a card, a note or a label. */
export function isNonSpeech(text: string): boolean {
  return normalizeForCer(speechText(text)).length === 0;
}

/**
 * Text compared character by character: NFKC (full-width forms, half-width katakana),
 * lower case, no spaces, punctuation or symbols. Latin letters and digits stay.
 */
export function normalizeForCer(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, "")
    .replace(/[ー]+/g, "ー");
}

/** Levenshtein distance over code points, O(n·m) time and O(m) memory. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export interface CerResult {
  /** Edits / reference characters (can exceed 1 when the hypothesis is much longer). */
  cer: number;
  edits: number;
  refChars: number;
  hypChars: number;
}

/** Character error rate of `hypothesis` against `reference`, both normalised first. */
export function cer(reference: string, hypothesis: string): CerResult {
  const ref = [...normalizeForCer(reference)];
  const hyp = [...normalizeForCer(hypothesis)];
  const edits = editDistance(ref, hyp);
  return {
    cer: ref.length ? edits / ref.length : hyp.length ? 1 : 0,
    edits,
    refChars: ref.length,
    hypChars: hyp.length,
  };
}

function ngrams(chars: readonly string[], n: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i++) {
    const gram = chars.slice(i, i + n).join("");
    out.set(gram, (out.get(gram) ?? 0) + 1);
  }
  return out;
}

/**
 * chrF (Popović 2015): F-score of character n-grams, n = 1…6, recall weighted by beta = 2,
 * on text without spaces and punctuation, 0–100. Used for translations into Chinese: it
 * needs no word segmentation, and over a whole stretch it does not care where the lines
 * were split, which differs between our captions and the creator's.
 */
export function chrF(reference: string, hypothesis: string, maxN = 6, beta = 2): number {
  const ref = [...normalizeForCer(reference)];
  const hyp = [...normalizeForCer(hypothesis)];
  let precisionSum = 0;
  let recallSum = 0;
  let orders = 0;
  for (let n = 1; n <= maxN; n++) {
    const r = ngrams(ref, n);
    const h = ngrams(hyp, n);
    let refTotal = 0;
    let hypTotal = 0;
    let matched = 0;
    for (const count of r.values()) refTotal += count;
    for (const [gram, count] of h) {
      hypTotal += count;
      matched += Math.min(count, r.get(gram) ?? 0);
    }
    if (!refTotal || !hypTotal) continue;
    precisionSum += matched / hypTotal;
    recallSum += matched / refTotal;
    orders++;
  }
  if (!orders) return 0;
  const p = precisionSum / orders;
  const r = recallSum / orders;
  if (!p && !r) return 0;
  const b2 = beta * beta;
  return (100 * (1 + b2) * p * r) / (b2 * p + r);
}

/** Share of `a`'s character bigrams found in `b` (0–1), after normalisation. */
export function bigramOverlap(a: string, b: string): number {
  const x = [...normalizeForCer(a)];
  const y = new Set(ngrams([...normalizeForCer(b)], 2).keys());
  if (x.length < 2) return x.length && normalizeForCer(b).includes(x[0]!) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i + 1 < x.length; i++) if (y.has(x[i]! + x[i + 1]!)) hit++;
  return hit / (x.length - 1);
}
