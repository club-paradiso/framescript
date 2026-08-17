/**
 * Importance scoring.
 *
 * Turns the local metric set plus surrounding context into one salience score
 * in [0,1]. The adaptive sampler spends its deep-analysis budget in descending
 * order of this score, so this function decides what the expensive part of the
 * system ever looks at.
 *
 * The score is a weighted heuristic. It is not a probability of anything and is
 * never shown to the user as one.
 */

import type { TemporalMetrics } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';

export interface ImportanceContext {
  /** Media time of the observation being scored. */
  timestamp: MediaTimeMs;
  /** ms since the previous detected scene cut, if any. */
  msSinceSceneCut?: number;
  /** A subtitle cue starts or ends within ~250 ms of this observation. */
  nearSubtitleBoundary?: boolean;
  /** Speech onset detected by VAD within ~250 ms. */
  nearSpeechOnset?: boolean;
  /** A sound event was detected within ~400 ms. */
  nearSoundEvent?: boolean;
  /** The user seeked to this position (they care about it by definition). */
  userSeek?: boolean;
  /** Consecutive prior observations that were visually near-identical. */
  staticStreak?: number;
}

export interface ImportanceWeights {
  frameDifference: number;
  motion: number;
  sceneCut: number;
  textChange: number;
  faceChange: number;
}

export const DEFAULT_WEIGHTS: ImportanceWeights = {
  frameDifference: 0.15,
  motion: 0.25,
  sceneCut: 0.35,
  textChange: 0.15,
  faceChange: 0.1,
};

/**
 * Contextual boosts. These encode the screenplay-relevant claim that *change
 * co-occurring with speech or sound matters more than change alone*: a hand
 * moving while someone speaks is a gesture, the same hand moving in silence is
 * usually just a hand.
 */
const BOOSTS = {
  sceneCutRecency: 0.2,
  subtitleBoundary: 0.12,
  speechOnset: 0.15,
  soundEvent: 0.12,
  userSeek: 0.25,
} as const;

export function scoreImportance(
  metrics: TemporalMetrics,
  context: ImportanceContext,
  weights: ImportanceWeights = DEFAULT_WEIGHTS,
): number {
  const base =
    (metrics.frameDifference ?? 0) * weights.frameDifference +
    (metrics.motionScore ?? 0) * weights.motion +
    (metrics.sceneCutScore ?? 0) * weights.sceneCut +
    (metrics.textChangeScore ?? 0) * weights.textChange +
    (metrics.faceChangeScore ?? 0) * weights.faceChange;

  let score = Math.min(1, base * 1.6);

  if (context.msSinceSceneCut !== undefined && context.msSinceSceneCut <= 1500) {
    // Right after a cut, establishing detail is unusually valuable.
    score += BOOSTS.sceneCutRecency * (1 - context.msSinceSceneCut / 1500);
  }
  if (context.nearSubtitleBoundary) score += BOOSTS.subtitleBoundary;
  if (context.nearSpeechOnset) score += BOOSTS.speechOnset;
  if (context.nearSoundEvent) score += BOOSTS.soundEvent;
  if (context.userSeek) score += BOOSTS.userSeek;

  // A long visually-identical streak is evidence that nothing is happening.
  if (context.staticStreak && context.staticStreak > 5) {
    score *= Math.max(0.25, 1 - (context.staticStreak - 5) * 0.06);
  }

  // A frame with no image at all (protected playback, fade to black) is not
  // "important" no matter what the difference metrics say about the transition.
  if ((metrics.luminance ?? 1) < 0.02 && (metrics.sceneCutScore ?? 0) < 0.5) score *= 0.3;

  return Math.max(0, Math.min(1, score));
}

/** Threshold above which an observation is worth recording as an event at all. */
export const EVENT_THRESHOLD = 0.08;

/** Threshold above which a window is promoted to peak deep-analysis rate. */
export const PROMOTION_THRESHOLD = 0.55;

export function isRedundant(metrics: TemporalMetrics): boolean {
  return (
    (metrics.frameDifference ?? 0) < 0.006 &&
    (metrics.motionScore ?? 0) < 0.02 &&
    (metrics.sceneCutScore ?? 0) < 0.05
  );
}
