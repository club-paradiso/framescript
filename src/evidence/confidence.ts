/**
 * Confidence arithmetic.
 *
 * FrameScript uses four ordinal levels, not percentages. None of our sources
 * produce calibrated probabilities, so printing "97.38% confident" would be a
 * lie dressed as precision. Combining rules below are explicitly ordinal.
 */

import type { ConfidenceLevel } from './types';

const ORDER: Record<ConfidenceLevel, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const BY_RANK: ConfidenceLevel[] = ['unknown', 'low', 'medium', 'high'];

export const confidenceRank = (level: ConfidenceLevel): number => ORDER[level];

export function fromRank(rank: number): ConfidenceLevel {
  const clamped = Math.max(0, Math.min(BY_RANK.length - 1, Math.round(rank)));
  return BY_RANK[clamped]!;
}

export function minConfidence(...levels: ConfidenceLevel[]): ConfidenceLevel {
  if (levels.length === 0) return 'unknown';
  return fromRank(Math.min(...levels.map(confidenceRank)));
}

export function maxConfidence(...levels: ConfidenceLevel[]): ConfidenceLevel {
  if (levels.length === 0) return 'unknown';
  return fromRank(Math.max(...levels.map(confidenceRank)));
}

/**
 * Confidence for a claim supported by several independent sources.
 *
 * Agreement between two independent sources raises confidence by one step, but
 * never above `high`, and repeated agreement from *the same* source raises
 * nothing — a subtitle observed twice is still one subtitle.
 */
export function corroborate(levels: readonly ConfidenceLevel[], distinctSources: number): ConfidenceLevel {
  if (levels.length === 0) return 'unknown';
  const best = Math.max(...levels.map(confidenceRank));
  const bonus = distinctSources >= 2 ? 1 : 0;
  return fromRank(Math.min(ORDER.high, best + bonus));
}

/**
 * Confidence for a chain of reasoning: the result is never stronger than its
 * weakest link, and inference costs one step.
 */
export function derive(base: ConfidenceLevel, inferred: boolean): ConfidenceLevel {
  return inferred ? fromRank(confidenceRank(base) - 1) : base;
}

/**
 * Maps a heuristic score in [0,1] to an ordinal level.
 *
 * The thresholds are conservative on purpose: a local frame-difference score is
 * a weak signal, so even a strong one only earns `medium` unless a second
 * source agrees.
 */
export function fromScore(score: number, opts: { strongEvidence?: boolean } = {}): ConfidenceLevel {
  if (!Number.isFinite(score)) return 'unknown';
  const ceiling = opts.strongEvidence ? ORDER.high : ORDER.medium;
  let rank: number;
  if (score >= 0.75) rank = ORDER.high;
  else if (score >= 0.45) rank = ORDER.medium;
  else if (score > 0) rank = ORDER.low;
  else rank = ORDER.unknown;
  return fromRank(Math.min(rank, ceiling));
}

export function describeConfidence(level: ConfidenceLevel): string {
  switch (level) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'low':
      return 'Low confidence';
    case 'unknown':
      return 'Confidence unknown';
  }
}
