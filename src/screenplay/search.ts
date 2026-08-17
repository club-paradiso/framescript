/**
 * Local screenplay search.
 *
 * Runs entirely in memory over the scene model. Nothing is indexed remotely and
 * no query leaves the device.
 */

import { comparableText } from '../utils/text';
import type { MediaTimeMs } from '../utils/time';
import type { CharacterEntity } from '../characters/entities';
import type { ReconstructedScene, SceneBeat } from '../scenes/types';

export type SearchScope = 'all' | 'dialogue' | 'action' | 'speaker';

export interface SearchOptions {
  scope?: SearchScope;
  /** Search every language variant, not just the displayed one. */
  allLanguages?: boolean;
  language?: string;
  characters?: readonly CharacterEntity[];
  limit?: number;
}

export interface SearchResult {
  beatId: string;
  sceneId: string;
  start: MediaTimeMs;
  kind: SceneBeat['type'];
  /** The matched text with surrounding context. */
  snippet: string;
  language?: string;
  characterName?: string;
  /** Character offset of the match within `snippet`, for highlighting. */
  matchStart: number;
  matchLength: number;
}

export function searchScreenplay(
  scenes: readonly ReconstructedScene[],
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const needle = comparableText(query);
  if (needle.length === 0) return [];

  const scope = options.scope ?? 'all';
  const limit = options.limit ?? 200;
  const characterNames = new Map(
    (options.characters ?? []).map((c) => [c.id, c.displayName ?? c.id] as const),
  );
  const results: SearchResult[] = [];

  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (results.length >= limit) return results;

      if (beat.type === 'dialogue' && (scope === 'all' || scope === 'dialogue' || scope === 'speaker')) {
        if (scope === 'speaker') {
          const name = beat.characterId ? characterNames.get(beat.characterId) : undefined;
          if (name && comparableText(name).includes(needle)) {
            const variant = pickVariant(beat.textVariants, options);
            results.push(
              makeResult(beat, scene.id, variant?.text ?? '', 0, 0, {
                ...(variant?.language ? { language: variant.language } : {}),
                characterName: name,
              }),
            );
          }
          continue;
        }

        const variants = options.allLanguages
          ? Object.values(beat.textVariants)
          : [pickVariant(beat.textVariants, options)].filter(Boolean);

        for (const variant of variants) {
          if (!variant) continue;
          const match = findMatch(variant.text, needle);
          if (!match) continue;
          const name = beat.characterId ? characterNames.get(beat.characterId) : undefined;
          results.push(
            makeResult(beat, scene.id, variant.text, match.start, match.length, {
              language: variant.language,
              ...(name ? { characterName: name } : {}),
            }),
          );
          break;
        }
        continue;
      }

      if (scope === 'all' || scope === 'action') {
        const text = beatText(beat);
        if (!text) continue;
        const match = findMatch(text, needle);
        if (match) results.push(makeResult(beat, scene.id, text, match.start, match.length, {}));
      }
    }
  }
  return results;
}

function beatText(beat: SceneBeat): string | null {
  switch (beat.type) {
    case 'action':
      return beat.description;
    case 'sound':
      return beat.description;
    case 'on-screen-text':
      return beat.text;
    case 'transition':
      return beat.label;
    case 'dialogue':
      return null;
  }
}

function pickVariant(
  variants: Record<string, { language: string; text: string }>,
  options: SearchOptions,
): { language: string; text: string } | undefined {
  if (options.language && variants[options.language]) return variants[options.language];
  return Object.values(variants)[0];
}

/**
 * Locates a match in the *original* text.
 *
 * Comparison happens on normalized text (case- and punctuation-insensitive), so
 * the two strings have different lengths and offsets cannot be reused directly.
 * A single pass builds the normalized form alongside an index map back to the
 * original, which keeps this linear — the naive approach of re-normalizing a
 * growing prefix per character is quadratic and shows up on long action lines.
 */
export function findMatch(text: string, needle: string): { start: number; length: number } | null {
  const { normalized, indexMap } = normalizeWithMap(text);
  const index = normalized.indexOf(needle);
  if (index < 0) return null;

  const start = indexMap[index] ?? 0;
  const endNormalized = index + needle.length;
  // The character after the match in the original, or the end of the string.
  const end = endNormalized < indexMap.length ? (indexMap[endNormalized] ?? text.length) : text.length;
  return { start, length: Math.max(1, end - start) };
}

/**
 * Normalizes for comparison while recording the original index of each output
 * character. Mirrors `comparableText` minus the NFKC pass, which is omitted
 * precisely because it can change character counts and break the mapping.
 */
function normalizeWithMap(text: string): { normalized: string; indexMap: number[] } {
  let normalized = '';
  const indexMap: number[] = [];
  let lastWasSpace = true;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (/[\s ]/.test(char)) {
      if (lastWasSpace) continue;
      normalized += ' ';
      indexMap.push(i);
      lastWasSpace = true;
      continue;
    }
    if (/[.,!?;:'"()[\]{}\-–—…·‘’ʼ“”]/.test(char)) continue;

    normalized += char.toLowerCase();
    indexMap.push(i);
    lastWasSpace = false;
  }

  // Trailing space, if any, is not part of the comparable form.
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    indexMap.pop();
  }
  return { normalized, indexMap };
}

function makeResult(
  beat: SceneBeat,
  sceneId: string,
  snippet: string,
  matchStart: number,
  matchLength: number,
  extra: { language?: string; characterName?: string },
): SearchResult {
  return {
    beatId: beat.id,
    sceneId,
    start: beat.start,
    kind: beat.type,
    snippet,
    matchStart,
    matchLength,
    ...extra,
  };
}
