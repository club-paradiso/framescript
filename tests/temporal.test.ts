import { describe, expect, it } from 'vitest';
import {
  computeFrameSignature,
  isBlankFrame,
  signatureFromLuma,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
} from '@/temporal/FrameSignature';
import {
  computeTemporalMetrics,
  frameDifference,
  histogramDistance,
  motionScore,
  regionDifference,
  sceneCutScore,
  SUBTITLE_REGION,
} from '@/temporal/FrameDifference';
import { EVENT_THRESHOLD, isRedundant, scoreImportance } from '@/temporal/ImportanceScorer';
import { AdaptiveSampler } from '@/temporal/AdaptiveSampler';
import { ActionSegmenter, findHesitations, mergeAdjacentSegments } from '@/temporal/ActionSegmenter';
import { TemporalScanner } from '@/temporal/TemporalScanner';
import { effectiveObservationFps, profileFor } from '@/temporal/fidelity';
import type { TemporalVisualEvent } from '@/evidence/types';

const CELLS = SIGNATURE_WIDTH * SIGNATURE_HEIGHT;

/** Uniform grey frame. */
const flat = (value: number, t = 0) => signatureFromLuma(new Uint8Array(CELLS).fill(value), t);

/** Frame with a bright block at a normalized position, for localized motion. */
function withBlock(base: number, blockValue: number, x0: number, y0: number, w: number, h: number, t = 0) {
  const luma = new Uint8Array(CELLS).fill(base);
  for (let y = y0; y < Math.min(y0 + h, SIGNATURE_HEIGHT); y++) {
    for (let x = x0; x < Math.min(x0 + w, SIGNATURE_WIDTH); x++) luma[y * SIGNATURE_WIDTH + x] = blockValue;
  }
  return signatureFromLuma(luma, t);
}

/** RGBA buffer of a solid colour, for the signature-from-pixels path. */
function solidRgba(width: number, height: number, r: number, g: number, b: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe('frame signatures', () => {
  it('box-averages source pixels into the signature grid', () => {
    const sig = computeFrameSignature({
      data: solidRgba(320, 180, 128, 128, 128),
      width: 320,
      height: 180,
      timestamp: 0,
    });
    expect(sig.luma).toHaveLength(CELLS);
    expect(sig.meanLuma).toBeCloseTo(128 / 255, 2);
    expect(sig.lumaStdDev).toBeLessThan(0.01);
  });

  it('produces a normalized histogram', () => {
    const sig = flat(100);
    const total = [...sig.histogram].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('detects blank frames, which is how protected playback presents', () => {
    expect(isBlankFrame(flat(0))).toBe(true);
    expect(isBlankFrame(flat(3))).toBe(true);
    expect(isBlankFrame(flat(128))).toBe(false);
    // A dark but textured frame is a real picture, not a blank one.
    expect(isBlankFrame(withBlock(2, 90, 4, 4, 8, 6))).toBe(false);
  });
});

describe('frame difference metrics', () => {
  it('reports zero difference for identical frames', () => {
    expect(frameDifference(flat(100), flat(100))).toBe(0);
    expect(histogramDistance(flat(100), flat(100))).toBeCloseTo(0, 5);
  });

  it('reports maximum difference between black and white', () => {
    expect(frameDifference(flat(0), flat(255))).toBeCloseTo(1, 5);
  });

  it('scores a hard cut higher than a localized movement', () => {
    const shotA = withBlock(40, 200, 2, 2, 10, 8);
    const shotB = flat(210);
    const moved = withBlock(40, 200, 6, 2, 10, 8);

    const cut = sceneCutScore(shotA, shotB);
    const movement = sceneCutScore(shotA, moved);
    expect(cut).toBeGreaterThan(movement);
    expect(cut).toBeGreaterThan(0.6);
  });

  it('scores localized movement as motion rather than as a cut', () => {
    const a = withBlock(60, 220, 4, 6, 5, 5);
    const b = withBlock(60, 220, 9, 6, 5, 5);
    const metrics = computeTemporalMetrics(a, b);
    expect(metrics.motionScore!).toBeGreaterThan(0.1);
    // Requiring both pixel and histogram change is what keeps this from
    // reading as a scene change.
    expect(metrics.sceneCutScore!).toBeLessThan(0.6);
  });

  it('treats a fade to black as a cut even though the histogram barely moves', () => {
    expect(sceneCutScore(flat(200), flat(5))).toBeGreaterThan(0.6);
  });

  it('measures change restricted to a region', () => {
    const y0 = Math.floor(SUBTITLE_REGION.y * SIGNATURE_HEIGHT);
    const a = flat(50);
    const b = withBlock(50, 240, 5, y0, 12, 3);
    expect(regionDifference(a, b, SUBTITLE_REGION)).toBeGreaterThan(0.05);
    // The same change is invisible to a region that does not contain it.
    expect(regionDifference(a, b, { x: 0, y: 0, width: 1, height: 0.2 })).toBe(0);
  });

  it('does not report motion between identical frames', () => {
    expect(motionScore(flat(120), flat(120))).toBe(0);
  });
});

describe('importance scoring', () => {
  const base = { timestamp: 1000 };

  it('rates a scene cut above ordinary motion', () => {
    const cut = scoreImportance({ sceneCutScore: 0.9, frameDifference: 0.6, motionScore: 0.3 }, base);
    const motion = scoreImportance({ sceneCutScore: 0.1, frameDifference: 0.2, motionScore: 0.3 }, base);
    expect(cut).toBeGreaterThan(motion);
  });

  it('boosts change that co-occurs with speech', () => {
    const metrics = { motionScore: 0.3, frameDifference: 0.2 };
    const withSpeech = scoreImportance(metrics, { ...base, nearSpeechOnset: true });
    expect(withSpeech).toBeGreaterThan(scoreImportance(metrics, base));
  });

  it('decays importance across a long static streak', () => {
    const metrics = { motionScore: 0.3, frameDifference: 0.2 };
    const fresh = scoreImportance(metrics, { ...base, staticStreak: 0 });
    const stale = scoreImportance(metrics, { ...base, staticStreak: 30 });
    expect(stale).toBeLessThan(fresh);
  });

  it('suppresses black frames so protected playback does not look eventful', () => {
    const metrics = { motionScore: 0.4, frameDifference: 0.3, luminance: 0.005 };
    const lit = scoreImportance({ ...metrics, luminance: 0.5 }, base);
    expect(scoreImportance(metrics, base)).toBeLessThan(lit);
  });

  it('flags visually identical observations as redundant', () => {
    expect(isRedundant({ frameDifference: 0.001, motionScore: 0.005, sceneCutScore: 0.01 })).toBe(true);
    expect(isRedundant({ frameDifference: 0.05, motionScore: 0.2, sceneCutScore: 0.1 })).toBe(false);
  });

  it('keeps scores within [0,1]', () => {
    const extreme = scoreImportance(
      { sceneCutScore: 1, frameDifference: 1, motionScore: 1, textChangeScore: 1, faceChangeScore: 1 },
      { ...base, nearSpeechOnset: true, nearSoundEvent: true, userSeek: true, msSinceSceneCut: 0 },
    );
    expect(extreme).toBeLessThanOrEqual(1);
    expect(extreme).toBeGreaterThan(0.9);
  });
});

describe('adaptive sampling', () => {
  const event = (timestamp: number, importance: number, sceneCut = 0): TemporalVisualEvent => ({
    timestamp,
    importance,
    metrics: { sceneCutScore: sceneCut, motionScore: importance },
  });

  it('keeps deep analysis far below the observation rate in ordinary material', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('detailed') });
    // 60 seconds of moderate activity at 10 observations per second.
    let analyzed = 0;
    for (let i = 0; i < 600; i++) {
      if (sampler.decide(event(i * 100, 0.3)).analyze) analyzed++;
    }
    expect(sampler.consideredCount).toBe(600);
    // This is the core economic claim of the design: observe 10x per second,
    // analyze roughly 1x per second.
    expect(analyzed).toBeGreaterThan(30);
    expect(analyzed).toBeLessThan(120);
  });

  it('never analyzes an observation below the importance floor', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('detailed') });
    for (let i = 0; i < 100; i++) {
      expect(sampler.decide(event(i * 100, 0.05)).analyze).toBe(false);
    }
  });

  it('always spends a token on a scene cut', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('detailed') });
    const decision = sampler.decide(event(0, 0.9, 0.8));
    expect(decision.analyze).toBe(true);
    expect(decision.reason).toBe('scene-cut');
  });

  it('raises the rate inside a promoted window and lets it lapse afterwards', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('detailed'), promotionDurationMs: 2000 });
    sampler.decide(event(0, 0.9));
    expect(sampler.isPromoted(1000)).toBe(true);
    expect(sampler.isPromoted(5000)).toBe(false);
  });

  it('bounds a rapid montage instead of analyzing every cut', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('detailed') });
    let analyzed = 0;
    // 100 cuts over 10 seconds — far above any sustainable inference rate.
    for (let i = 0; i < 100; i++) {
      if (sampler.decide(event(i * 100, 0.95, 0.9)).analyze) analyzed++;
    }
    expect(analyzed).toBeLessThan(100);
  });

  it('does not mint tokens when time runs backwards after a seek', () => {
    const sampler = new AdaptiveSampler({ profile: profileFor('efficient') });
    sampler.decide(event(60_000, 0.5));
    const before = sampler.analyzedCount;
    sampler.decide(event(1_000, 0.5));
    expect(sampler.analyzedCount).toBeLessThanOrEqual(before + 1);
  });

  it('efficient mode analyzes less than detailed mode on the same input', () => {
    const count = (fidelity: 'efficient' | 'detailed') => {
      const sampler = new AdaptiveSampler({ profile: profileFor(fidelity) });
      let analyzed = 0;
      for (let i = 0; i < 300; i++) if (sampler.decide(event(i * 100, 0.35)).analyze) analyzed++;
      return analyzed;
    };
    expect(count('efficient')).toBeLessThan(count('detailed'));
  });
});

describe('action segmentation', () => {
  const event = (timestamp: number, motion: number, cut = 0): TemporalVisualEvent => ({
    timestamp,
    importance: Math.max(motion, cut),
    metrics: { motionScore: motion, sceneCutScore: cut },
  });

  it('groups a run of observations into one action rather than six lines', () => {
    const segmenter = new ActionSegmenter();
    // The door-opening sequence from the product spec, at 100 ms.
    for (const t of [0, 100, 200, 300, 400, 500, 600]) segmenter.push(event(t, 0.4));
    const segment = segmenter.flush();

    expect(segment).not.toBeNull();
    expect(segment!.eventTimestamps).toHaveLength(7);
    expect(segment!.start).toBe(0);
    expect(segment!.end).toBe(600);
  });

  it('closes a segment at a scene cut', () => {
    const segmenter = new ActionSegmenter();
    segmenter.push(event(0, 0.4));
    segmenter.push(event(100, 0.4));
    const closed = segmenter.push(event(200, 0.9, 0.8));
    expect(closed).not.toBeNull();
    expect(closed!.end).toBe(100);
  });

  it('closes a segment after a gap in activity', () => {
    const segmenter = new ActionSegmenter();
    segmenter.push(event(0, 0.4));
    segmenter.push(event(100, 0.4));
    const closed = segmenter.push(event(2000, 0.4));
    expect(closed).not.toBeNull();
    expect(closed!.end).toBe(100);
  });

  it('preserves a hesitation between two bursts of movement', () => {
    const segmenter = new ActionSegmenter();
    // reach ... hold still 400 ms ... pull back
    segmenter.push(event(0, 0.4));
    segmenter.push(event(100, 0.4));
    for (const t of [200, 300, 400, 500]) segmenter.push(event(t, 0.01));
    segmenter.push(event(600, 0.4));
    const segment = segmenter.flush();

    expect(segment!.hesitations).toHaveLength(1);
    expect(segment!.hesitations[0]!.start).toBe(200);
    expect(segment!.hesitations[0]!.end).toBe(600);
  });

  it('does not report a trailing pause as a hesitation', () => {
    // Stillness at the end of an action is the action ending, not a hesitation.
    const events = [event(0, 0.4), event(100, 0.4), event(200, 0.01), event(300, 0.01)];
    expect(findHesitations(events, { minHesitationMs: 250, hesitationMotionCeiling: 0.06 })).toHaveLength(0);
  });

  it('ignores stillness too brief to be meaningful', () => {
    const events = [event(0, 0.4), event(100, 0.01), event(200, 0.4)];
    expect(findHesitations(events, { minHesitationMs: 250, hesitationMotionCeiling: 0.06 })).toHaveLength(0);
  });

  it('merges adjacent segments that describe one continuous action', () => {
    const segmenter = new ActionSegmenter();
    for (const t of [0, 100, 200]) segmenter.push(event(t, 0.4));
    segmenter.push(event(1000, 0.4));
    for (const t of [1100, 1200]) segmenter.push(event(t, 0.4));
    segmenter.flush();

    const merged = mergeAdjacentSegments(segmenter.completed, 900);
    expect(merged.length).toBeLessThan(segmenter.completed.length);
  });

  it('does not merge across a cut', () => {
    const segments = [
      { start: 0, end: 500, startsOnCut: false },
      { start: 600, end: 1000, startsOnCut: true },
    ].map((s, i) => ({
      id: `a${i}`,
      ...s,
      eventTimestamps: [s.start],
      participantIds: [],
      peakImportance: 0.4,
      meanMotion: 0.4,
      hesitations: [],
      confidence: 'medium' as const,
    }));
    expect(mergeAdjacentSegments(segments, 900)).toHaveLength(2);
  });
});

describe('temporal scanner', () => {
  const rgbaFromLuma = (value: number, width = 32, height = 18) => solidRgba(width, height, value, value, value);

  it('measures roughly 10 observations per second in detailed mode', () => {
    const scanner = new TemporalScanner({ profile: profileFor('detailed') });
    // 3 seconds of 100 ms observations with slight variation so nothing is
    // discarded as redundant.
    for (let i = 0; i <= 30; i++) {
      scanner.observe({ data: rgbaFromLuma(100 + (i % 5) * 12), width: 32, height: 18, timestamp: i * 100 });
    }
    expect(scanner.stats.observations).toBe(31);
    expect(scanner.stats.observedFps).toBeCloseTo(10, 0);
  });

  it('skips visually identical frames instead of emitting events for them', () => {
    const scanner = new TemporalScanner({ profile: profileFor('detailed') });
    for (let i = 0; i <= 50; i++) {
      scanner.observe({ data: rgbaFromLuma(100), width: 32, height: 18, timestamp: i * 100 });
    }
    expect(scanner.stats.observations).toBe(51);
    expect(scanner.stats.emittedEvents).toBe(0);
    expect(scanner.stats.redundantSkipped).toBeGreaterThan(45);
  });

  it('reports a scene cut and requests deep analysis for it', () => {
    const cuts: number[] = [];
    const deep: number[] = [];
    const scanner = new TemporalScanner({
      profile: profileFor('detailed'),
      callbacks: {
        onSceneCut: (t) => cuts.push(t),
        onDeepAnalysisRequest: (r) => deep.push(r.timestamp),
      },
    });

    scanner.observe({ data: rgbaFromLuma(20), width: 32, height: 18, timestamp: 0 });
    scanner.observe({ data: rgbaFromLuma(230), width: 32, height: 18, timestamp: 100 });

    expect(cuts).toEqual([100]);
    expect(deep).toContain(100);
  });

  it('reports blank frames once so protected playback is surfaced, not spammed', () => {
    let reports = 0;
    const scanner = new TemporalScanner({
      profile: profileFor('detailed'),
      blankFrameThreshold: 5,
      callbacks: { onBlankFramesDetected: () => reports++ },
    });
    for (let i = 0; i < 40; i++) {
      scanner.observe({ data: rgbaFromLuma(0), width: 32, height: 18, timestamp: i * 100 });
    }
    expect(reports).toBe(1);
  });

  it('does not diff across a seek after continuity is reset', () => {
    const events: number[] = [];
    const scanner = new TemporalScanner({
      profile: profileFor('detailed'),
      callbacks: { onTemporalEvent: (e) => events.push(e.timestamp) },
    });
    scanner.observe({ data: rgbaFromLuma(20), width: 32, height: 18, timestamp: 0 });
    scanner.resetContinuity();
    // Without the reset this jump would register as a full-frame scene cut.
    scanner.observe({ data: rgbaFromLuma(230), width: 32, height: 18, timestamp: 60_000 });
    expect(events).toHaveLength(0);
  });

  it('emits only observations above the event threshold', () => {
    const scanner = new TemporalScanner({ profile: profileFor('detailed') });
    scanner.observe({ data: rgbaFromLuma(100), width: 32, height: 18, timestamp: 0 });
    const event = scanner.observe({ data: rgbaFromLuma(101), width: 32, height: 18, timestamp: 100 });
    // A one-level luma change is not an event.
    expect(event === null || event.importance >= EVENT_THRESHOLD).toBe(true);
  });
});

describe('fidelity profiles', () => {
  it('separates observation rate from deep-analysis rate', () => {
    const detailed = profileFor('detailed');
    expect(detailed.temporalIntervalMs).toBe(100);
    expect(detailed.baselineDeepFps).toBeLessThan(1000 / detailed.temporalIntervalMs);
  });

  it('caps forensic observation at the media frame rate', () => {
    const forensic = profileFor('forensic');
    expect(forensic.temporalIntervalMs).toBe(0);
    // Cannot observe 30 times a second from a 24 fps film, and must not claim to.
    expect(effectiveObservationFps(forensic, 24)).toBe(24);
  });

  it('caps detailed observation at the media frame rate when it is lower', () => {
    expect(effectiveObservationFps(profileFor('detailed'), 8)).toBe(8);
    expect(effectiveObservationFps(profileFor('detailed'), 24)).toBe(10);
  });
});
