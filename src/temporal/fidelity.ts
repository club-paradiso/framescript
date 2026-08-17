/**
 * Analysis fidelity profiles.
 *
 * The central design decision of the temporal engine lives here: **temporal
 * observation rate and deep-analysis rate are separate numbers.**
 *
 * Detailed mode observes the picture ten times a second (100 ms) but sends only
 * a small, adaptively chosen subset for semantic analysis. A 120-minute film at
 * 10 fps yields 72,000 observations; sending all of them to a multimodal model
 * would be slow, costly, redundant, and a privacy problem. Observing densely
 * and analyzing selectively is what makes dense observation affordable.
 */

export type AnalysisFidelity = 'efficient' | 'detailed' | 'forensic';

export interface FidelityProfile {
  id: AnalysisFidelity;
  label: string;
  description: string;
  /**
   * Target interval between temporal observations, in ms.
   * `0` means "every presented frame" (driven by requestVideoFrameCallback).
   */
  temporalIntervalMs: number;
  /** Deep semantic analyses per second in ordinary material. */
  baselineDeepFps: number;
  /** Ceiling for deep analysis inside a promoted (important) window. */
  peakDeepFps: number;
  /** Downscaled analysis frame size. Never affects playback resolution. */
  analysisWidth: number;
  analysisHeight: number;
  /** Higher-resolution pass used only when OCR or fine detail is needed. */
  detailWidth: number;
  detailHeight: number;
  /** Maximum keyframes held in memory awaiting analysis. */
  keyframeBufferSize: number;
}

export const FIDELITY_PROFILES: Record<AnalysisFidelity, FidelityProfile> = {
  efficient: {
    id: 'efficient',
    label: 'Efficient',
    description:
      'About 5 temporal observations per second with sparse deep analysis. Lowest CPU and battery cost.',
    temporalIntervalMs: 200,
    baselineDeepFps: 0.5,
    peakDeepFps: 2,
    analysisWidth: 320,
    analysisHeight: 180,
    detailWidth: 640,
    detailHeight: 360,
    keyframeBufferSize: 24,
  },
  detailed: {
    id: 'detailed',
    label: 'Detailed',
    description:
      '100 ms temporal observation (10 per second) with adaptive deep analysis. Recommended.',
    temporalIntervalMs: 100,
    baselineDeepFps: 1,
    peakDeepFps: 10,
    analysisWidth: 480,
    analysisHeight: 270,
    detailWidth: 960,
    detailHeight: 540,
    keyframeBufferSize: 48,
  },
  forensic: {
    id: 'forensic',
    label: 'Forensic',
    description:
      'Observes every presented frame the browser exposes and keeps denser evidence. Deep analysis stays adaptive — the whole film is never uploaded frame by frame.',
    temporalIntervalMs: 0,
    baselineDeepFps: 2,
    peakDeepFps: 15,
    analysisWidth: 640,
    analysisHeight: 360,
    detailWidth: 1280,
    detailHeight: 720,
    keyframeBufferSize: 96,
  },
};

export const DEFAULT_FIDELITY: AnalysisFidelity = 'detailed';

export function profileFor(fidelity: AnalysisFidelity): FidelityProfile {
  return FIDELITY_PROFILES[fidelity];
}

/**
 * Effective observation rate for a profile given the media's own frame rate.
 *
 * Forensic mode is capped by the source: you cannot observe 30 times a second
 * from a 24 fps film. Reporting the honest number matters because the
 * diagnostics panel shows measured rates, not aspirational ones.
 */
export function effectiveObservationFps(profile: FidelityProfile, mediaFps?: number): number {
  if (profile.temporalIntervalMs === 0) return mediaFps ?? 30;
  const target = 1000 / profile.temporalIntervalMs;
  return mediaFps ? Math.min(target, mediaFps) : target;
}
