/**
 * Text utilities shared by subtitle normalization, screenplay rendering and
 * export filename generation.
 *
 * Every character class below is written with explicit escapes rather than
 * literal characters. Zero-width joiners and non-breaking spaces are invisible
 * in an editor, and a regex whose behaviour depends on characters nobody can
 * see is a regex nobody can safely change.
 */

/** Characters that carry no meaning but do break string equality checks. */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060\u00AD]/g;

/** Whitespace, including the non-breaking space players use for layout. */
const WHITESPACE = /[\s\u00A0]+/g;

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, '');
}

/** Collapses all whitespace runs (including NBSP and newlines) to single spaces. */
export function collapseWhitespace(input: string): string {
  return input.replace(WHITESPACE, ' ').trim();
}

/**
 * Normalization used for *comparison only* — never for the text we display.
 * Deliberately aggressive: case, punctuation and quote style are all discarded
 * so that "I don't." and "I dont" compare equal when deduplicating cues.
 */
export function comparableText(input: string): string {
  return stripInvisible(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[.,!?;:'"()[\]{}\-\u2013\u2014\u2026\u00B7]/g, '')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * True when `next` extends `prev` — the signature of YouTube's progressive
 * (word-by-word) live captions.
 */
export function isProgressiveExtension(prev: string, next: string): boolean {
  const a = comparableText(prev);
  const b = comparableText(next);
  if (a.length === 0) return b.length > 0;
  if (b.length <= a.length) return false;
  return b.startsWith(a) && (b[a.length] === ' ' || a.endsWith(' '));
}

/** Normalized Levenshtein similarity in [0, 1]. */
export function textSimilarity(a: string, b: string): number {
  const s = comparableText(a);
  const t = comparableText(b);
  if (s === t) return 1;
  if (s.length === 0 || t.length === 0) return 0;
  const distance = levenshtein(s, t);
  return 1 - distance / Math.max(s.length, t.length);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Scripts kept verbatim in slugs: kana, CJK ideographs and Hangul syllables. */
const SLUG_KEEP = /[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g;

/**
 * Filesystem-safe slug for export filenames.
 *
 * The NFKD pass strips Latin diacritics, but it also decomposes Hangul
 * syllables into conjoining jamo, which then fall outside the syllable range
 * kept above — turning a Korean title into an empty slug. Recomposing with NFC
 * afterwards restores the syllables while keeping the diacritic stripping.
 */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(SLUG_KEEP, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'framescript';
}

/** Screenplay character cues are conventionally upper case. */
export function toCharacterCue(name: string): string {
  return collapseWhitespace(name).toLocaleUpperCase();
}

/**
 * Sentence-splitting good enough to group action lines. Intentionally simple:
 * we only ever apply it to text we generated ourselves, never to dialogue.
 */
export function splitSentences(input: string): string[] {
  return input
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True if the string is plausibly CJK, used for dual-language layout choices. */
export function containsCjk(input: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(input);
}
