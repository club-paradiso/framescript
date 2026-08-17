/**
 * Frame signatures.
 *
 * A signature is a tiny, fixed-size summary of one analysis frame: a
 * downsampled luma grid plus a luma histogram. Everything the 100 ms scanner
 * measures is computed from signatures rather than from full frames, which is
 * what keeps 10 observations per second cheap enough to run beside 4K playback.
 *
 * Signatures are also the reason FrameScript does not retain media: once a
 * signature is computed the pixels are dropped.
 */

import type { MediaTimeMs } from '../utils/time';

/** Grid dimensions for the luma summary. 32x18 preserves 16:9 composition. */
export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 18;
export const HISTOGRAM_BINS = 32;

export interface FrameSignature {
  timestamp: MediaTimeMs;
  frameSequence?: number;
  /** Row-major luma grid, 0-255, SIGNATURE_WIDTH x SIGNATURE_HEIGHT. */
  luma: Uint8Array;
  /** Normalized luma histogram; sums to 1. */
  histogram: Float32Array;
  /** Mean luma in [0,1]. Near zero indicates a black/protected frame. */
  meanLuma: number;
  /** Standard deviation of luma in [0,1]; near zero means a flat frame. */
  lumaStdDev: number;
  /** Source frame dimensions the signature was computed from. */
  sourceWidth: number;
  sourceHeight: number;
}

/** BT.601 luma, matching what canvas 2D gives us cheaply. */
export function rgbaToLuma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

export interface SignatureInput {
  /** RGBA pixel data as produced by `CanvasRenderingContext2D.getImageData`. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  timestamp: MediaTimeMs;
  frameSequence?: number;
}

/**
 * Computes a signature by box-averaging the source into the signature grid.
 *
 * Box averaging (rather than point sampling) matters: point sampling makes
 * frame-difference scores explode on film grain and on the dithering that
 * appears in dark scenes, producing phantom "motion" in a locked-off shot.
 */
export function computeFrameSignature(input: SignatureInput): FrameSignature {
  const { data, width, height, timestamp } = input;
  const luma = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
  const histogram = new Float32Array(HISTOGRAM_BINS);

  const cellW = width / SIGNATURE_WIDTH;
  const cellH = height / SIGNATURE_HEIGHT;
  let sum = 0;
  let sumSq = 0;

  for (let gy = 0; gy < SIGNATURE_HEIGHT; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
    for (let gx = 0; gx < SIGNATURE_WIDTH; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));

      let acc = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        const rowOffset = y * width * 4;
        for (let x = x0; x < x1 && x < width; x++) {
          const i = rowOffset + x * 4;
          acc += rgbaToLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
          count++;
        }
      }
      const value = count > 0 ? Math.round(acc / count) : 0;
      const index = gy * SIGNATURE_WIDTH + gx;
      luma[index] = value;
      sum += value;
      sumSq += value * value;
      histogram[Math.min(HISTOGRAM_BINS - 1, (value * HISTOGRAM_BINS) >> 8)]! += 1;
    }
  }

  const n = luma.length;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  for (let i = 0; i < HISTOGRAM_BINS; i++) histogram[i]! /= n;

  const sig: FrameSignature = {
    timestamp,
    luma,
    histogram,
    meanLuma: mean / 255,
    lumaStdDev: Math.sqrt(variance) / 255,
    sourceWidth: width,
    sourceHeight: height,
  };
  if (input.frameSequence !== undefined) sig.frameSequence = input.frameSequence;
  return sig;
}

/**
 * True when a frame carries no usable image.
 *
 * Protected (DRM) playback commonly yields all-black frames to canvas readback.
 * Detecting that is how FrameScript reports "video unavailable" honestly
 * instead of emitting a stream of meaningless "the screen is dark" events.
 */
export function isBlankFrame(sig: FrameSignature): boolean {
  return sig.meanLuma < 0.02 && sig.lumaStdDev < 0.01;
}

/** Builds a signature directly from a luma grid — used by tests and fixtures. */
export function signatureFromLuma(
  luma: Uint8Array,
  timestamp: MediaTimeMs,
  sourceWidth = SIGNATURE_WIDTH,
  sourceHeight = SIGNATURE_HEIGHT,
): FrameSignature {
  if (luma.length !== SIGNATURE_WIDTH * SIGNATURE_HEIGHT) {
    throw new Error(`Expected ${SIGNATURE_WIDTH * SIGNATURE_HEIGHT} luma samples, got ${luma.length}`);
  }
  const histogram = new Float32Array(HISTOGRAM_BINS);
  let sum = 0;
  let sumSq = 0;
  for (const value of luma) {
    sum += value;
    sumSq += value * value;
    histogram[Math.min(HISTOGRAM_BINS - 1, (value * HISTOGRAM_BINS) >> 8)]! += 1;
  }
  const n = luma.length;
  const mean = sum / n;
  for (let i = 0; i < HISTOGRAM_BINS; i++) histogram[i]! /= n;
  return {
    timestamp,
    luma: new Uint8Array(luma),
    histogram,
    meanLuma: mean / 255,
    lumaStdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) / 255,
    sourceWidth,
    sourceHeight,
  };
}
