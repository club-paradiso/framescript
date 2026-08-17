/**
 * The temporal scanner.
 *
 * Consumes one analysis frame at a time and produces temporal events. It is
 * deliberately synchronous and side-effect free apart from its callbacks, so
 * the whole 100 ms path can be driven by synthetic frames in tests.
 *
 * What it does NOT do: touch the network, hold pixel data, or call a model.
 * Frames become signatures immediately and the pixels are discarded.
 */

import type { TemporalMetrics, TemporalVisualEvent } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';
import { computeFrameSignature, isBlankFrame, type FrameSignature, type SignatureInput } from './FrameSignature';
import { computeTemporalMetrics, regionEdgeEnergy, TITLE_REGION } from './FrameDifference';
import { AdaptiveSampler, type SamplingDecision } from './AdaptiveSampler';
import { EVENT_THRESHOLD, isRedundant, scoreImportance, type ImportanceContext } from './ImportanceScorer';
import type { FidelityProfile } from './fidelity';

export interface DeepAnalysisRequest {
  timestamp: MediaTimeMs;
  importance: number;
  reason: SamplingDecision['reason'];
  metrics: TemporalMetrics;
  /** True when the title band looks like it contains superimposed text. */
  textLikely: boolean;
}

export interface TemporalScannerCallbacks {
  onTemporalEvent?: (event: TemporalVisualEvent) => void;
  onSceneCut?: (timestamp: MediaTimeMs, score: number) => void;
  onDeepAnalysisRequest?: (request: DeepAnalysisRequest) => void;
  /**
   * Called once when frames are consistently blank, which is how protected
   * playback presents to canvas readback. The caller marks the video source
   * `protected-content` rather than emitting meaningless dark-frame events.
   */
  onBlankFramesDetected?: () => void;
}

export interface TemporalScannerOptions {
  profile: FidelityProfile;
  callbacks?: TemporalScannerCallbacks;
  /** Consecutive blank frames before we declare the video source unusable. */
  blankFrameThreshold?: number;
}

export interface ScannerStats {
  observations: number;
  emittedEvents: number;
  redundantSkipped: number;
  deepRequests: number;
  sceneCuts: number;
  blankFrames: number;
  /** Measured observation rate in Hz over the observed media span. */
  observedFps: number;
  lastTimestamp: MediaTimeMs | null;
}

/** Context the scanner cannot derive from pixels alone, supplied per observation. */
export interface ObservationContext {
  nearSubtitleBoundary?: boolean;
  nearSpeechOnset?: boolean;
  nearSoundEvent?: boolean;
  userSeek?: boolean;
}

export class TemporalScanner {
  #profile: FidelityProfile;
  #callbacks: TemporalScannerCallbacks;
  #sampler: AdaptiveSampler;
  #blankThreshold: number;

  #previous: FrameSignature | null = null;
  #lastSceneCutAt: MediaTimeMs | null = null;
  #staticStreak = 0;
  #consecutiveBlank = 0;
  #blankReported = false;

  #stats: ScannerStats = {
    observations: 0,
    emittedEvents: 0,
    redundantSkipped: 0,
    deepRequests: 0,
    sceneCuts: 0,
    blankFrames: 0,
    observedFps: 0,
    lastTimestamp: null,
  };
  #firstTimestamp: MediaTimeMs | null = null;

  constructor(options: TemporalScannerOptions) {
    this.#profile = options.profile;
    this.#callbacks = options.callbacks ?? {};
    this.#blankThreshold = options.blankFrameThreshold ?? 20;
    this.#sampler = new AdaptiveSampler({ profile: options.profile });
  }

  get stats(): Readonly<ScannerStats> {
    return this.#stats;
  }

  get sampler(): AdaptiveSampler {
    return this.#sampler;
  }

  /** Discards continuity state. Call after a seek so we do not diff across a jump. */
  resetContinuity(): void {
    this.#previous = null;
    this.#staticStreak = 0;
    this.#lastSceneCutAt = null;
    this.#sampler.reset();
  }

  /**
   * Observes one frame.
   *
   * Returns the temporal event when one was emitted, or null when the frame was
   * redundant (visually identical to its predecessor) — the common case in a
   * locked-off shot, and the reason 10 fps observation is affordable.
   */
  observe(input: SignatureInput, context: ObservationContext = {}): TemporalVisualEvent | null {
    const signature = computeFrameSignature(input);
    this.#stats.observations++;
    this.#stats.lastTimestamp = signature.timestamp;
    if (this.#firstTimestamp === null) this.#firstTimestamp = signature.timestamp;
    this.#updateFps(signature.timestamp);

    if (isBlankFrame(signature)) {
      this.#stats.blankFrames++;
      this.#consecutiveBlank++;
      if (this.#consecutiveBlank >= this.#blankThreshold && !this.#blankReported) {
        this.#blankReported = true;
        this.#callbacks.onBlankFramesDetected?.();
      }
    } else {
      this.#consecutiveBlank = 0;
    }

    const previous = this.#previous;
    this.#previous = signature;
    if (!previous) return null;

    const metrics = computeTemporalMetrics(previous, signature);

    if (isRedundant(metrics)) {
      this.#staticStreak++;
      this.#stats.redundantSkipped++;
      return null;
    }
    this.#staticStreak = 0;

    const sceneCutScore = metrics.sceneCutScore ?? 0;
    if (sceneCutScore >= 0.6) {
      this.#lastSceneCutAt = signature.timestamp;
      this.#stats.sceneCuts++;
      this.#callbacks.onSceneCut?.(signature.timestamp, sceneCutScore);
    }

    const importanceContext: ImportanceContext = {
      timestamp: signature.timestamp,
      staticStreak: this.#staticStreak,
      ...context,
    };
    if (this.#lastSceneCutAt !== null) {
      importanceContext.msSinceSceneCut = signature.timestamp - this.#lastSceneCutAt;
    }

    const importance = scoreImportance(metrics, importanceContext);
    if (importance < EVENT_THRESHOLD) return null;

    const event: TemporalVisualEvent = { timestamp: signature.timestamp, metrics, importance };
    if (signature.frameSequence !== undefined) event.frameSequence = signature.frameSequence;

    this.#stats.emittedEvents++;
    this.#callbacks.onTemporalEvent?.(event);

    const decision = this.#sampler.decide(event);
    if (decision.analyze) {
      this.#stats.deepRequests++;
      this.#callbacks.onDeepAnalysisRequest?.({
        timestamp: signature.timestamp,
        importance,
        reason: decision.reason,
        metrics,
        textLikely: regionEdgeEnergy(signature, TITLE_REGION) > 0.35,
      });
    }
    return event;
  }

  #updateFps(timestamp: MediaTimeMs): void {
    const span = timestamp - (this.#firstTimestamp ?? timestamp);
    this.#stats.observedFps = span > 0 ? (this.#stats.observations - 1) / (span / 1000) : 0;
  }

  get profile(): FidelityProfile {
    return this.#profile;
  }
}
