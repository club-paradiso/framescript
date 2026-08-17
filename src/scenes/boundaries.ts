/**
 * Scene boundary detection.
 *
 * No single signal forces a scene break. A film cuts between two angles of the
 * same conversation constantly; each cut is a shot change, not a scene change.
 * So boundaries are *scored* from co-occurring signals, and a break is declared
 * only when enough independent evidence lines up within a short span.
 */

import type { MediaTimeMs } from '../utils/time';
import type { ConfidenceLevel, EvidenceEvent } from '../evidence/types';
import { fromScore } from '../evidence/confidence';

export type SceneBoundarySignalKind =
  | 'visual-cut'
  | 'sustained-visual-change'
  | 'location-change'
  | 'ambience-change'
  | 'dialogue-gap'
  | 'long-silence'
  | 'chapter-change'
  | 'music-transition'
  | 'user-seek'
  | 'on-screen-text';

export interface SceneBoundarySignal {
  kind: SceneBoundarySignalKind;
  timestamp: MediaTimeMs;
  /** Strength of this individual signal, in [0,1]. */
  strength: number;
}

export interface SceneBoundaryCandidate {
  timestamp: MediaTimeMs;
  signals: SceneBoundarySignal[];
  score: number;
  confidence: ConfidenceLevel;
}

/**
 * Weights encode how much each signal alone argues for a *scene* change rather
 * than a shot change. A chapter marker is near-decisive; a single cut is not.
 */
const SIGNAL_WEIGHTS: Record<SceneBoundarySignalKind, number> = {
  'chapter-change': 0.9,
  'location-change': 0.6,
  'user-seek': 0.55,
  'long-silence': 0.35,
  'ambience-change': 0.35,
  'sustained-visual-change': 0.35,
  'on-screen-text': 0.3,
  'music-transition': 0.25,
  'dialogue-gap': 0.25,
  'visual-cut': 0.2,
};

export interface BoundaryOptions {
  /** Signals within this window are treated as one candidate. */
  clusterWindowMs?: number;
  /** Score required to declare a boundary. */
  threshold?: number;
  /** Minimum scene length; shorter candidates are suppressed. */
  minSceneDurationMs?: number;
  /** Dialogue gap long enough to count as a boundary signal. */
  dialogueGapMs?: number;
}

const BOUNDARY_DEFAULTS: Required<BoundaryOptions> = {
  clusterWindowMs: 1_200,
  threshold: 0.55,
  minSceneDurationMs: 6_000,
  dialogueGapMs: 6_000,
};

/** Derives boundary signals from raw evidence. */
export function collectBoundarySignals(
  events: readonly EvidenceEvent[],
  options: BoundaryOptions = {},
): SceneBoundarySignal[] {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const signals: SceneBoundarySignal[] = [];
  const spoken: { start: MediaTimeMs; end: MediaTimeMs }[] = [];

  for (const event of events) {
    switch (event.source) {
      case 'video': {
        const cutScore = event.payload.metrics?.sceneCutScore ?? 0;
        if (event.payload.kind === 'scene-change' && cutScore > 0) {
          signals.push({ kind: 'visual-cut', timestamp: event.start, strength: Math.min(1, cutScore) });
        }
        if (event.payload.kind === 'setting') {
          signals.push({ kind: 'location-change', timestamp: event.start, strength: 0.8 });
        }
        break;
      }
      case 'audio-event': {
        if (event.payload.kind === 'ambience-change') {
          signals.push({ kind: 'ambience-change', timestamp: event.start, strength: 0.7 });
        }
        if (event.payload.kind === 'music-start' || event.payload.kind === 'music-end') {
          signals.push({ kind: 'music-transition', timestamp: event.start, strength: 0.5 });
        }
        break;
      }
      case 'audio-silence': {
        if (event.payload.significant) {
          signals.push({
            kind: 'long-silence',
            timestamp: event.end ?? event.start,
            strength: Math.min(1, event.payload.durationMs / 8_000),
          });
        }
        break;
      }
      case 'playback': {
        if (event.payload.kind === 'seek') {
          signals.push({ kind: 'user-seek', timestamp: event.start, strength: 1 });
        }
        break;
      }
      case 'metadata': {
        if (event.payload.kind === 'chapter') {
          signals.push({ kind: 'chapter-change', timestamp: event.start, strength: 1 });
        }
        break;
      }
      case 'ocr': {
        signals.push({ kind: 'on-screen-text', timestamp: event.start, strength: 0.6 });
        break;
      }
      case 'subtitle':
      case 'audio-asr': {
        spoken.push({ start: event.start, end: event.end ?? event.start + 1_000 });
        break;
      }
      case 'audio-speaker':
      case 'user':
        break;
    }
  }

  // Long stretches with no dialogue at all are weak scene-break evidence.
  spoken.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spoken.length; i++) {
    const gap = spoken[i]!.start - spoken[i - 1]!.end;
    if (gap >= opts.dialogueGapMs) {
      signals.push({
        kind: 'dialogue-gap',
        timestamp: spoken[i - 1]!.end + Math.floor(gap / 2),
        strength: Math.min(1, gap / 15_000),
      });
    }
  }

  return signals.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Clusters signals into candidates and scores them.
 *
 * Score combines weighted strengths with diminishing returns, so five cuts in a
 * row do not outweigh one chapter marker plus one location change.
 */
export function scoreBoundaryCandidates(
  signals: readonly SceneBoundarySignal[],
  options: BoundaryOptions = {},
): SceneBoundaryCandidate[] {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const sorted = [...signals].sort((a, b) => a.timestamp - b.timestamp);
  const clusters: SceneBoundarySignal[][] = [];

  for (const signal of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && signal.timestamp - current[0]!.timestamp <= opts.clusterWindowMs) {
      current.push(signal);
    } else {
      clusters.push([signal]);
    }
  }

  return clusters.map((cluster) => {
    // One contribution per signal *kind*; repeats of a kind add little.
    const byKind = new Map<SceneBoundarySignalKind, number>();
    for (const signal of cluster) {
      const value = SIGNAL_WEIGHTS[signal.kind] * signal.strength;
      byKind.set(signal.kind, Math.max(byKind.get(signal.kind) ?? 0, value));
    }
    const contributions = [...byKind.values()].sort((a, b) => b - a);
    let score = 0;
    contributions.forEach((value, index) => {
      score += value * 0.6 ** index;
    });
    score = Math.min(1, score);

    // A boundary supported by several independent kinds is strong evidence;
    // one supported by a single cut is not, whatever its raw score.
    const strongEvidence = byKind.size >= 2;
    return {
      timestamp: pickBoundaryTimestamp(cluster),
      signals: cluster,
      score,
      confidence: fromScore(score, { strongEvidence }),
    };
  });
}

/**
 * Within a cluster the visual cut is the true boundary instant — a silence or a
 * dialogue gap only tells us a break happened somewhere nearby.
 */
function pickBoundaryTimestamp(cluster: readonly SceneBoundarySignal[]): MediaTimeMs {
  const cut = cluster.find((s) => s.kind === 'visual-cut');
  if (cut) return cut.timestamp;
  const chapter = cluster.find((s) => s.kind === 'chapter-change');
  if (chapter) return chapter.timestamp;
  const seek = cluster.find((s) => s.kind === 'user-seek');
  if (seek) return seek.timestamp;
  return cluster[0]!.timestamp;
}

/** Applies the threshold and the minimum-duration rule. */
export function selectBoundaries(
  candidates: readonly SceneBoundaryCandidate[],
  options: BoundaryOptions = {},
): SceneBoundaryCandidate[] {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const out: SceneBoundaryCandidate[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.timestamp - b.timestamp)) {
    if (candidate.score < opts.threshold) continue;
    const previous = out[out.length - 1];
    if (previous && candidate.timestamp - previous.timestamp < opts.minSceneDurationMs) {
      // Two candidates too close together: keep the better-supported one.
      if (candidate.score > previous.score) out[out.length - 1] = candidate;
      continue;
    }
    out.push(candidate);
  }
  return out;
}

/** Convenience pipeline: evidence in, boundaries out. */
export function detectSceneBoundaries(
  events: readonly EvidenceEvent[],
  options: BoundaryOptions = {},
): SceneBoundaryCandidate[] {
  return selectBoundaries(scoreBoundaryCandidates(collectBoundarySignals(events, options), options), options);
}
