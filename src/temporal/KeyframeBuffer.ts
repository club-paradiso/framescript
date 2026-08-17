/**
 * Bounded keyframe ring buffer.
 *
 * Deep analysis needs *sequences* of frames, not isolated stills — "reaches,
 * hesitates, pulls back" is invisible in a single image. So a small ring of
 * recent downscaled frames is kept so a request can be assembled with temporal
 * ordering intact.
 *
 * Two hard rules, both enforced here:
 *   1. The ring is fixed-size. It cannot grow into a recording of the film.
 *   2. Entries are evicted by age and dropped entirely when analysis stops.
 *
 * This is the only place in FrameScript that holds image bytes at all, and it
 * holds at most a couple of seconds' worth at analysis resolution.
 */

import type { MediaTimeMs } from '../utils/time';
import type { EphemeralFrameRef } from '../evidence/types';

export interface Keyframe {
  timestamp: MediaTimeMs;
  frameSequence?: number;
  width: number;
  height: number;
  /** Encoded image bytes (JPEG/WebP). Never written to disk. */
  data: Uint8Array;
  mimeType: string;
}

export class KeyframeBuffer {
  #frames: Keyframe[] = [];
  #capacity: number;
  #maxBytes: number;
  #bytes = 0;
  #dropped = 0;

  constructor(capacity: number, maxBytes = 8 * 1024 * 1024) {
    this.#capacity = Math.max(1, capacity);
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#frames.length;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  get droppedCount(): number {
    return this.#dropped;
  }

  push(frame: Keyframe): void {
    this.#frames.push(frame);
    this.#bytes += frame.data.byteLength;
    while (this.#frames.length > this.#capacity || this.#bytes > this.#maxBytes) {
      const evicted = this.#frames.shift();
      if (!evicted) break;
      this.#bytes -= evicted.data.byteLength;
      this.#dropped++;
    }
  }

  /** Frames within `[start, end]`, oldest first. */
  range(start: MediaTimeMs, end: MediaTimeMs): Keyframe[] {
    return this.#frames.filter((f) => f.timestamp >= start && f.timestamp <= end);
  }

  /**
   * Selects at most `maxFrames` frames spanning a window, evenly spaced.
   *
   * Even spacing (rather than "the first N") preserves the shape of the action:
   * a model needs the beginning, middle and end of a gesture to describe its
   * progression.
   */
  sampleWindow(start: MediaTimeMs, end: MediaTimeMs, maxFrames: number): Keyframe[] {
    const candidates = this.range(start, end);
    if (candidates.length <= maxFrames) return candidates;
    const out: Keyframe[] = [];
    const step = (candidates.length - 1) / (maxFrames - 1);
    for (let i = 0; i < maxFrames; i++) {
      const frame = candidates[Math.round(i * step)];
      if (frame && out[out.length - 1] !== frame) out.push(frame);
    }
    return out;
  }

  nearest(timestamp: MediaTimeMs, toleranceMs = 250): Keyframe | undefined {
    let best: Keyframe | undefined;
    let bestDelta = Infinity;
    for (const f of this.#frames) {
      const delta = Math.abs(f.timestamp - timestamp);
      if (delta < bestDelta && delta <= toleranceMs) {
        best = f;
        bestDelta = delta;
      }
    }
    return best;
  }

  /** Drops every retained frame. Called whenever analysis stops or pauses. */
  clear(): void {
    this.#frames = [];
    this.#bytes = 0;
  }
}

export function toFrameRef(frame: Keyframe): EphemeralFrameRef {
  const ref: EphemeralFrameRef = {
    timestamp: frame.timestamp,
    width: frame.width,
    height: frame.height,
  };
  if (frame.frameSequence !== undefined) ref.frameSequence = frame.frameSequence;
  return ref;
}
