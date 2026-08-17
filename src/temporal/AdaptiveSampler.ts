/**
 * Adaptive deep-analysis scheduling.
 *
 * The 100 ms scanner produces ten observations a second. This class decides
 * which of them earn expensive semantic analysis, under a strict budget.
 *
 * Model: a token bucket denominated in *media seconds*. Tokens refill at the
 * profile's baseline rate; a burst of importance "promotes" the bucket to the
 * peak rate for a short window. Because the bucket is finite, a rapid montage
 * raises the analysis rate but can never make it unbounded — which is the
 * property that keeps playback smooth and keeps a 2-hour film from turning into
 * tens of thousands of inference requests.
 */

import type { MediaTimeMs } from '../utils/time';
import type { FidelityProfile } from './fidelity';
import { PROMOTION_THRESHOLD } from './ImportanceScorer';
import type { TemporalVisualEvent } from '../evidence/types';

export interface AdaptiveSamplerOptions {
  profile: FidelityProfile;
  /** How long a promotion lasts after the triggering observation. */
  promotionDurationMs?: number;
  /** Importance at or above which a promotion is triggered. */
  promotionThreshold?: number;
  /** Burst capacity in tokens (each token = one deep analysis). */
  burstCapacity?: number;
}

export interface SamplingDecision {
  analyze: boolean;
  reason:
    | 'scene-cut'
    | 'promoted-window'
    | 'baseline-budget'
    | 'below-threshold'
    | 'budget-exhausted'
    | 'rate-limited'
    | 'redundant';
  /** Tokens remaining after the decision, for diagnostics. */
  tokens: number;
  promoted: boolean;
}

export class AdaptiveSampler {
  #profile: FidelityProfile;
  #promotionDurationMs: number;
  #promotionThreshold: number;
  #capacity: number;

  #tokens: number;
  #lastRefillAt: MediaTimeMs | null = null;
  #promotedUntil: MediaTimeMs = -Infinity;
  #lastAnalysisAt: MediaTimeMs = -Infinity;

  #analyzed = 0;
  #considered = 0;

  constructor(options: AdaptiveSamplerOptions) {
    this.#profile = options.profile;
    this.#promotionDurationMs = options.promotionDurationMs ?? 2_000;
    this.#promotionThreshold = options.promotionThreshold ?? PROMOTION_THRESHOLD;
    this.#capacity = options.burstCapacity ?? Math.max(3, Math.ceil(options.profile.peakDeepFps));
    this.#tokens = this.#capacity;
  }

  get analyzedCount(): number {
    return this.#analyzed;
  }

  get consideredCount(): number {
    return this.#considered;
  }

  /** Observed deep-analysis rate as a fraction of observations. */
  get analysisRatio(): number {
    return this.#considered === 0 ? 0 : this.#analyzed / this.#considered;
  }

  isPromoted(at: MediaTimeMs): boolean {
    return at <= this.#promotedUntil;
  }

  /** Resets budget state, e.g. after a seek into unobserved territory. */
  reset(): void {
    this.#tokens = this.#capacity;
    this.#lastRefillAt = null;
    this.#promotedUntil = -Infinity;
    this.#lastAnalysisAt = -Infinity;
  }

  decide(event: TemporalVisualEvent): SamplingDecision {
    this.#considered++;
    const now = event.timestamp;
    this.#refill(now);

    if (event.importance >= this.#promotionThreshold) {
      this.#promotedUntil = now + this.#promotionDurationMs;
    }
    const promoted = this.isPromoted(now);
    const rateCeiling = promoted ? this.#profile.peakDeepFps : Math.max(this.#profile.baselineDeepFps, 0.01);
    const minIntervalMs = 1000 / rateCeiling;

    const isSceneCut = (event.metrics.sceneCutScore ?? 0) >= 0.6;

    // A scene cut is structural: it defines where scenes begin, so it jumps the
    // importance floor and relaxes the rate ceiling. It still has to pay a
    // token — otherwise a rapid montage would grant unlimited analyses, which
    // is exactly the unbounded behaviour the budget exists to prevent.
    if (isSceneCut && this.#tokens >= 1 && now - this.#lastAnalysisAt >= minIntervalMs * 0.5) {
      return this.#grant(now, 'scene-cut', promoted);
    }

    if (event.importance < 0.15) {
      return { analyze: false, reason: 'below-threshold', tokens: this.#tokens, promoted };
    }
    if (now - this.#lastAnalysisAt < minIntervalMs) {
      return { analyze: false, reason: 'rate-limited', tokens: this.#tokens, promoted };
    }
    if (this.#tokens < 1) {
      return { analyze: false, reason: 'budget-exhausted', tokens: this.#tokens, promoted };
    }
    return this.#grant(now, promoted ? 'promoted-window' : 'baseline-budget', promoted);
  }

  #grant(now: MediaTimeMs, reason: SamplingDecision['reason'], promoted: boolean): SamplingDecision {
    this.#tokens = Math.max(0, this.#tokens - 1);
    this.#lastAnalysisAt = now;
    this.#analyzed++;
    return { analyze: true, reason, tokens: this.#tokens, promoted };
  }

  #refill(now: MediaTimeMs): void {
    if (this.#lastRefillAt === null) {
      this.#lastRefillAt = now;
      return;
    }
    const elapsedMs = now - this.#lastRefillAt;
    if (elapsedMs <= 0) {
      // A seek backwards; treat as a fresh start rather than minting tokens.
      this.#lastRefillAt = now;
      return;
    }
    // Refill is ALWAYS at the baseline rate, never the peak rate.
    //
    // Promotion raises how fast tokens may be *spent* (the rate ceiling), not
    // how fast they are *earned*. That is what bounds the long run: a burst of
    // activity can drain the bucket quickly, but sustained activity — a montage,
    // an action sequence, a shaky handheld take — settles back to the baseline
    // instead of pinning deep analysis at the peak rate for minutes.
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + (elapsedMs / 1000) * this.#profile.baselineDeepFps,
    );
    this.#lastRefillAt = now;
  }
}
