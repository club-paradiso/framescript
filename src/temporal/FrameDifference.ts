/**
 * Frame-difference heuristics.
 *
 * All of these produce **heuristic scores in [0,1], not probabilities**. They
 * are deliberately local and deterministic: no model is involved, so they can
 * run 10 times a second next to 4K playback and can be unit tested exactly.
 */

import { HISTOGRAM_BINS, SIGNATURE_HEIGHT, SIGNATURE_WIDTH, type FrameSignature } from './FrameSignature';
import type { TemporalMetrics } from '../evidence/types';

/** Mean absolute luma difference, normalized to [0,1]. */
export function frameDifference(a: FrameSignature, b: FrameSignature): number {
  let sum = 0;
  const n = a.luma.length;
  for (let i = 0; i < n; i++) sum += Math.abs(a.luma[i]! - b.luma[i]!);
  return sum / (n * 255);
}

/**
 * Histogram intersection distance in [0,1].
 *
 * Complements frame difference: a whip pan within one location changes every
 * pixel but keeps a similar luma distribution, whereas a real cut usually
 * changes both. Using the two together suppresses false cuts on camera motion.
 */
export function histogramDistance(a: FrameSignature, b: FrameSignature): number {
  let intersection = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    intersection += Math.min(a.histogram[i]!, b.histogram[i]!);
  }
  return 1 - intersection;
}

/**
 * Block-wise motion score.
 *
 * Divides the grid into blocks and measures how *unevenly* change is
 * distributed. A cut changes everything uniformly (low unevenness, high
 * difference); a person moving through a static room changes a few blocks a lot
 * (high unevenness). That asymmetry is what separates "motion" from "cut".
 */
export function motionScore(a: FrameSignature, b: FrameSignature, blockSize = 4): number {
  const blocksX = Math.ceil(SIGNATURE_WIDTH / blockSize);
  const blocksY = Math.ceil(SIGNATURE_HEIGHT / blockSize);
  const blockDiffs: number[] = [];

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let sum = 0;
      let count = 0;
      for (let y = by * blockSize; y < Math.min((by + 1) * blockSize, SIGNATURE_HEIGHT); y++) {
        for (let x = bx * blockSize; x < Math.min((bx + 1) * blockSize, SIGNATURE_WIDTH); x++) {
          const i = y * SIGNATURE_WIDTH + x;
          sum += Math.abs(a.luma[i]! - b.luma[i]!);
          count++;
        }
      }
      if (count > 0) blockDiffs.push(sum / (count * 255));
    }
  }
  if (blockDiffs.length === 0) return 0;

  const mean = blockDiffs.reduce((s, v) => s + v, 0) / blockDiffs.length;
  if (mean <= 0.001) return 0;
  const max = Math.max(...blockDiffs);
  // Localized change (max >> mean) reads as motion; uniform change does not.
  const localization = Math.min(1, (max - mean) / Math.max(mean, 0.02));
  return Math.min(1, mean * 4 * (0.4 + 0.6 * localization));
}

/**
 * Scene-cut score.
 *
 * A cut requires *both* a large pixel difference and a large histogram change.
 * Requiring both is what stops a lighting flicker or a fast pan from being
 * reported as a new scene.
 */
export function sceneCutScore(a: FrameSignature, b: FrameSignature): number {
  const diff = frameDifference(a, b);
  const hist = histogramDistance(a, b);
  const combined = Math.sqrt(Math.max(0, diff) * Math.max(0, hist));

  // A cut to or from black is a cut even though the histogram barely moves.
  const lumaJump = Math.abs(a.meanLuma - b.meanLuma);
  const fadeSignal = lumaJump > 0.35 ? lumaJump : 0;

  return Math.min(1, Math.max(combined * 2.2, fadeSignal));
}

export interface Region {
  /** Normalized [0,1] coordinates within the frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where burned-in subtitles and captions normally sit. */
export const SUBTITLE_REGION: Region = { x: 0.1, y: 0.72, width: 0.8, height: 0.26 };
/** Where title cards and location supers normally sit. */
export const TITLE_REGION: Region = { x: 0.05, y: 0.05, width: 0.9, height: 0.35 };
/** Centre band where faces dominate in dialogue coverage. */
export const FACE_REGION: Region = { x: 0.2, y: 0.15, width: 0.6, height: 0.55 };

/** Mean absolute difference restricted to a normalized region. */
export function regionDifference(a: FrameSignature, b: FrameSignature, region: Region): number {
  const x0 = Math.floor(region.x * SIGNATURE_WIDTH);
  const x1 = Math.min(SIGNATURE_WIDTH, Math.ceil((region.x + region.width) * SIGNATURE_WIDTH));
  const y0 = Math.floor(region.y * SIGNATURE_HEIGHT);
  const y1 = Math.min(SIGNATURE_HEIGHT, Math.ceil((region.y + region.height) * SIGNATURE_HEIGHT));

  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * SIGNATURE_WIDTH + x;
      sum += Math.abs(a.luma[i]! - b.luma[i]!);
      count++;
    }
  }
  return count > 0 ? sum / (count * 255) : 0;
}

/**
 * Local contrast within a region, as a proxy for "text may be present".
 *
 * High-contrast, high-frequency content in the title band is characteristic of
 * superimposed text. This does **not** read characters — it only decides
 * whether a frame is worth sending to an OCR-capable provider.
 */
export function regionEdgeEnergy(sig: FrameSignature, region: Region): number {
  const x0 = Math.floor(region.x * SIGNATURE_WIDTH);
  const x1 = Math.min(SIGNATURE_WIDTH, Math.ceil((region.x + region.width) * SIGNATURE_WIDTH));
  const y0 = Math.floor(region.y * SIGNATURE_HEIGHT);
  const y1 = Math.min(SIGNATURE_HEIGHT, Math.ceil((region.y + region.height) * SIGNATURE_HEIGHT));

  let energy = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = y * SIGNATURE_WIDTH + x;
      energy += Math.abs(sig.luma[i]! - sig.luma[i + 1]!);
      count++;
    }
  }
  return count > 0 ? Math.min(1, energy / (count * 96)) : 0;
}

/** Computes the full metric set for one observation. */
export function computeTemporalMetrics(
  previous: FrameSignature,
  current: FrameSignature,
): TemporalMetrics {
  return {
    frameDifference: frameDifference(previous, current),
    motionScore: motionScore(previous, current),
    sceneCutScore: sceneCutScore(previous, current),
    textChangeScore: Math.max(
      regionDifference(previous, current, TITLE_REGION),
      regionDifference(previous, current, SUBTITLE_REGION),
    ),
    faceChangeScore: regionDifference(previous, current, FACE_REGION),
    luminance: current.meanLuma,
  };
}
