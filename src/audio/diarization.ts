/**
 * Speaker diarization.
 *
 * Answers exactly one question: **"does this speech come from the same voice as
 * that speech?"** It assigns anonymous cluster labels — `speaker-001`,
 * `speaker-002` — and stops there.
 *
 * It deliberately does NOT attempt to identify who anyone is. No face
 * recognition, no voice-print matching against any external database, no
 * guessing actor names. Naming a speaker is the user's decision, made in the
 * UI, and their correction then outranks everything this module produces.
 *
 * Method: mean cepstral feature vector per speech region, online agglomerative
 * clustering under cosine distance with a running centroid.
 */

import { computeMfcc, cosineDistance } from './dsp';
import type { MediaTimeMs } from '../utils/time';
import type { ConfidenceLevel } from '../evidence/types';

export interface SpeakerCluster {
  id: string;
  centroid: Float32Array;
  /** Number of regions merged into this cluster. */
  memberCount: number;
  totalDurationMs: number;
  firstSeenAt: MediaTimeMs;
  lastSeenAt: MediaTimeMs;
}

export interface DiarizationAssignment {
  speakerId: string;
  start: MediaTimeMs;
  end: MediaTimeMs;
  distance: number;
  /** True when the previous assignment had a different speaker. */
  turnChange: boolean;
  confidence: ConfidenceLevel;
  /** True when this region opened a new cluster. */
  isNewSpeaker: boolean;
}

export interface DiarizerOptions {
  sampleRate: number;
  /** Cosine distance below which a region joins an existing cluster. */
  mergeThreshold?: number;
  /** Above this distance we open a new cluster rather than force a match. */
  splitThreshold?: number;
  /** Frame length for feature extraction. */
  frameMs?: number;
  /** Hard cap on clusters; beyond this the nearest cluster always wins. */
  maxSpeakers?: number;
  /** Regions shorter than this carry too little signal to cluster reliably. */
  minRegionMs?: number;
}

/**
 * Thresholds.
 *
 * Calibrated against synthetic harmonic signals, where the same voice at
 * different levels measures ~0.00, two similar voices (110 Hz vs 140 Hz
 * fundamental) measure ~0.01, and two clearly different voices (110 Hz vs
 * 300 Hz) measure ~0.14. A merge threshold of 0.18 sat above that last figure
 * and collapsed obviously-distinct voices into one cluster.
 *
 * These are heuristics tuned on synthetic audio and need validation against
 * real speech — see docs/QA.md. The bias is deliberately toward *over-splitting*
 * rather than over-merging: a split cluster shows up as two speakers the viewer
 * can merge in one click, whereas a merged cluster silently attributes two
 * people's lines to one character.
 */
const DIARIZER_DEFAULTS = {
  mergeThreshold: 0.1,
  splitThreshold: 0.25,
  frameMs: 32,
  maxSpeakers: 12,
  minRegionMs: 400,
} as const;

export class SpeakerDiarizer {
  #options: Required<DiarizerOptions>;
  #clusters: SpeakerCluster[] = [];
  #counter = 0;
  #lastSpeakerId: string | null = null;

  constructor(options: DiarizerOptions) {
    this.#options = { ...DIARIZER_DEFAULTS, ...options };
  }

  get clusters(): readonly SpeakerCluster[] {
    return this.#clusters;
  }

  get speakerCount(): number {
    return this.#clusters.length;
  }

  /**
   * Assigns a speech region to a speaker cluster.
   *
   * Returns null for regions too short to characterize — silently guessing on
   * 200 ms of audio produces speaker churn that looks like a bug and corrupts
   * attribution downstream.
   */
  assign(samples: Float32Array, start: MediaTimeMs, end: MediaTimeMs): DiarizationAssignment | null {
    if (end - start < this.#options.minRegionMs) return null;
    const feature = this.#embed(samples);
    if (!feature) return null;

    const { cluster, distance } = this.#nearest(feature);
    let assigned: SpeakerCluster;
    let isNewSpeaker = false;

    if (cluster && distance <= this.#options.mergeThreshold) {
      this.#updateCluster(cluster, feature, start, end);
      assigned = cluster;
    } else if (cluster && distance < this.#options.splitThreshold && this.#clusters.length >= this.#options.maxSpeakers) {
      // At the cap we must choose an existing cluster; record the weak match.
      this.#updateCluster(cluster, feature, start, end);
      assigned = cluster;
    } else if (!cluster || distance >= this.#options.mergeThreshold) {
      if (this.#clusters.length >= this.#options.maxSpeakers && cluster) {
        this.#updateCluster(cluster, feature, start, end);
        assigned = cluster;
      } else {
        assigned = this.#createCluster(feature, start, end);
        isNewSpeaker = true;
      }
    } else {
      assigned = cluster;
    }

    const turnChange = this.#lastSpeakerId !== null && this.#lastSpeakerId !== assigned.id;
    this.#lastSpeakerId = assigned.id;

    return {
      speakerId: assigned.id,
      start,
      end,
      distance,
      turnChange,
      isNewSpeaker,
      confidence: distanceToConfidence(distance, this.#options),
    };
  }

  reset(): void {
    this.#clusters = [];
    this.#counter = 0;
    this.#lastSpeakerId = null;
  }

  /**
   * Mean cepstral vector over the region.
   *
   * Coefficient 0 (overall energy) is dropped so that the same voice recorded
   * loud and quiet lands in the same cluster.
   */
  #embed(samples: Float32Array): Float32Array | null {
    const frameSamples = Math.round((this.#options.sampleRate * this.#options.frameMs) / 1000);
    if (samples.length < frameSamples) return null;

    const hop = Math.max(1, Math.floor(frameSamples / 2));
    const accumulator = new Float32Array(12);
    let frames = 0;

    for (let offset = 0; offset + frameSamples <= samples.length; offset += hop) {
      const mfcc = computeMfcc(samples.subarray(offset, offset + frameSamples), this.#options.sampleRate);
      for (let i = 1; i < 13; i++) accumulator[i - 1]! += mfcc[i]!;
      frames++;
    }
    if (frames === 0) return null;
    for (let i = 0; i < accumulator.length; i++) accumulator[i]! /= frames;
    return accumulator;
  }

  #nearest(feature: Float32Array): { cluster: SpeakerCluster | null; distance: number } {
    let best: SpeakerCluster | null = null;
    let bestDistance = Infinity;
    for (const cluster of this.#clusters) {
      const distance = cosineDistance(feature, cluster.centroid);
      if (distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }
    return { cluster: best, distance: bestDistance };
  }

  #createCluster(feature: Float32Array, start: MediaTimeMs, end: MediaTimeMs): SpeakerCluster {
    this.#counter++;
    const cluster: SpeakerCluster = {
      id: `speaker-${String(this.#counter).padStart(3, '0')}`,
      centroid: new Float32Array(feature),
      memberCount: 1,
      totalDurationMs: end - start,
      firstSeenAt: start,
      lastSeenAt: end,
    };
    this.#clusters.push(cluster);
    return cluster;
  }

  #updateCluster(cluster: SpeakerCluster, feature: Float32Array, start: MediaTimeMs, end: MediaTimeMs): void {
    // Running mean, so later evidence refines the centroid without erasing it.
    const n = cluster.memberCount;
    for (let i = 0; i < cluster.centroid.length; i++) {
      cluster.centroid[i] = (cluster.centroid[i]! * n + feature[i]!) / (n + 1);
    }
    cluster.memberCount = n + 1;
    cluster.totalDurationMs += end - start;
    cluster.firstSeenAt = Math.min(cluster.firstSeenAt, start);
    cluster.lastSeenAt = Math.max(cluster.lastSeenAt, end);
  }
}

function distanceToConfidence(
  distance: number,
  options: Required<DiarizerOptions>,
): ConfidenceLevel {
  if (!Number.isFinite(distance)) return 'unknown';
  if (distance <= options.mergeThreshold * 0.5) return 'high';
  if (distance <= options.mergeThreshold) return 'medium';
  if (distance <= options.splitThreshold) return 'low';
  return 'unknown';
}

/**
 * Detects overlapping speech.
 *
 * Two speakers at once shows up as unusually high spectral variability within a
 * single region. This is a weak signal, so it is reported as a flag on the
 * region rather than as two separate speaker assignments.
 */
export function looksOverlapped(
  samples: Float32Array,
  sampleRate: number,
  frameMs = 32,
  varianceThreshold = 0.55,
): boolean {
  const frameSamples = Math.round((sampleRate * frameMs) / 1000);
  if (samples.length < frameSamples * 4) return false;

  const vectors: Float32Array[] = [];
  for (let offset = 0; offset + frameSamples <= samples.length; offset += frameSamples) {
    vectors.push(computeMfcc(samples.subarray(offset, offset + frameSamples), sampleRate));
  }
  if (vectors.length < 4) return false;

  let total = 0;
  let pairs = 0;
  for (let i = 1; i < vectors.length; i++) {
    total += cosineDistance(vectors[i - 1]!, vectors[i]!);
    pairs++;
  }
  return pairs > 0 && total / pairs > varianceThreshold;
}
