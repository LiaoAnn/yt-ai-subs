// Per-video glossary for translation: the first rendering of a name or recurring term is
// kept and given to every later translation request of the same video, so a name is not
// translated three ways. The translator reports the terms it translated ("terms" in its
// reply); the content script keeps them with the video's captions and in the cache.

/** Source term (as Whisper wrote it) -> its translation, in the order they were found. */
export type Glossary = Record<string, string>;

export const MAX_GLOSSARY_ENTRIES = 60;
/** At most this many entries go with one translation request. */
export const MAX_GLOSSARY_SENT = 20;
const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 30;

/** Honorifics after a name ("희영님", "田中さん"): the glossary keeps the bare name. */
const HONORIFIC = /\s*(?:님|씨|さん|ちゃん|くん|君|様|さま)$/u;
/** Neither target language (zh-TW, en) is written in Hangul or kana: such a "translation" was left as it was. */
const UNTRANSLATED = /[\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u;

const squash = (text: string) => text.replace(/[\s、。，,.!?！？…「」]/g, "").toLowerCase();
const length = (text: string) => [...text].length;

/**
 * Adds the translator's reported terms to `glossary` (in place): only terms that occur in
 * the lines just translated, and never over an entry that is already there (the first
 * rendering wins). Returns the entries added.
 */
export function mergeTerms(
  glossary: Glossary,
  terms: unknown,
  lines: readonly string[],
): [string, string][] {
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) return [];
  const text = squash(lines.join("\n"));
  const known = new Set(Object.keys(glossary).map(squash));
  const added: [string, string][] = [];
  for (const [rawSource, rawTarget] of Object.entries(terms as Record<string, unknown>)) {
    if (Object.keys(glossary).length >= MAX_GLOSSARY_ENTRIES) break;
    if (typeof rawTarget !== "string") continue;
    const source = rawSource.trim().replace(HONORIFIC, "");
    const target = rawTarget.trim();
    if (UNTRANSLATED.test(target)) continue;
    const key = squash(source);
    if (length(key) < MIN_TERM_CHARS || length(source) > MAX_TERM_CHARS) continue;
    if (!target || length(target) > MAX_TERM_CHARS) continue;
    if (known.has(key) || !text.includes(key)) continue;
    glossary[source] = target;
    known.add(key);
    added.push([source, target]);
  }
  return added;
}

/**
 * Makes a chunk's translations use the glossary's renderings where the translator used
 * another one for the same term (two chunks translated at once, or a glossary entry it
 * ignored): replaces its rendering, as it reported in `terms`, with the established one.
 * Returns the lines and the terms whose rendering was replaced.
 */
export function applyGlossary(
  translations: readonly string[],
  terms: unknown,
  glossary: Glossary,
): { lines: string[]; replaced: string[] } {
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    return { lines: [...translations], replaced: [] };
  }
  const established = new Map(Object.entries(glossary).map(([s, t]) => [squash(s), t]));
  let lines = [...translations];
  const replaced: string[] = [];
  for (const [source, rendering] of Object.entries(terms as Record<string, unknown>)) {
    const wanted = established.get(squash(source));
    if (typeof rendering !== "string" || !wanted) continue;
    const used = rendering.trim();
    // Short renderings would match inside other words.
    if (length(used) < MIN_TERM_CHARS || used === wanted || wanted.includes(used)) continue;
    if (!lines.some((line) => line.includes(used))) continue;
    lines = lines.map((line) => line.replaceAll(used, wanted));
    replaced.push(source);
  }
  return { lines, replaced };
}

/** The entries whose source term occurs in `texts` (the lines and their context). */
export function relevantTerms(
  glossary: Glossary,
  texts: readonly string[],
  max = MAX_GLOSSARY_SENT,
): [string, string][] {
  const text = squash(texts.join("\n"));
  return Object.entries(glossary)
    .filter(([source]) => text.includes(squash(source)))
    .slice(0, max);
}

/** A glossary read back from storage (anything else becomes an empty one). */
export function parseGlossary(value: unknown): Glossary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Glossary = {};
  for (const [source, target] of Object.entries(value as Record<string, unknown>)) {
    if (typeof target === "string" && source.trim() && target.trim()) out[source] = target;
    if (Object.keys(out).length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return out;
}

/** The translator's "terms" object from its JSON reply, or null. */
export function parseReplyTerms(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const json = JSON.parse(match[0]) as Record<string, unknown> | null;
    const terms = json?.terms;
    return typeof terms === "object" && terms !== null && !Array.isArray(terms)
      ? (terms as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
