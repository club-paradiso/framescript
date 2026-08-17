/**
 * Media clock.
 *
 * The offscreen document receives a `MediaStream` from `tabCapture`, which
 * carries no media timeline — only wall-clock frames. But every piece of
 * evidence FrameScript produces must be stamped in *media time*, or nothing
 * synchronizes with the subtitles or with the player's own position.
 *
 * So the content script periodically reports the player's real position, and
 * this class interpolates between reports using wall-clock elapsed time scaled
 * by the playback rate. Accuracy is bounded by the reporting interval, which is
 * why reports are frequent and why a pause or seek resets interpolation
 * immediately rather than drifting.
 */

import type { MediaTimeMs } from '../utils/time';

export interface ClockSample {
  mediaTimeMs: MediaTimeMs;
  playing: boolean;
  playbackRate?: number;
  /** Wall-clock time the sample was taken; defaults to now. */
  wallTimeMs?: number;
}

export class MediaClock {
  #mediaTimeMs: MediaTimeMs = 0;
  #wallTimeMs = 0;
  #playing = false;
  #playbackRate = 1;
  #hasSample = false;
  #now: () => number;

  /** Largest interpolation we will extrapolate before refusing to guess. */
  #maxExtrapolationMs: number;

  constructor(options: { now?: () => number; maxExtrapolationMs?: number } = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#maxExtrapolationMs = options.maxExtrapolationMs ?? 3_000;
  }

  get hasSample(): boolean {
    return this.#hasSample;
  }

  get playing(): boolean {
    return this.#playing;
  }

  update(sample: ClockSample): void {
    this.#mediaTimeMs = sample.mediaTimeMs;
    this.#wallTimeMs = sample.wallTimeMs ?? this.#now();
    this.#playing = sample.playing;
    if (sample.playbackRate !== undefined && sample.playbackRate > 0) {
      this.#playbackRate = sample.playbackRate;
    }
    this.#hasSample = true;
  }

  /**
   * Current media time.
   *
   * Returns null when no sample has arrived, or when the last sample is too old
   * to extrapolate from. Returning null is correct: an evidence event stamped
   * with a guessed timestamp is worse than no event, because it would be
   * silently misaligned with the dialogue around it.
   */
  now(): MediaTimeMs | null {
    if (!this.#hasSample) return null;
    if (!this.#playing) return this.#mediaTimeMs;

    const elapsed = this.#now() - this.#wallTimeMs;
    if (elapsed > this.#maxExtrapolationMs) return null;
    return Math.round(this.#mediaTimeMs + elapsed * this.#playbackRate);
  }

  /** Media time for a wall-clock instant in the recent past. */
  at(wallTimeMs: number): MediaTimeMs | null {
    if (!this.#hasSample) return null;
    const delta = wallTimeMs - this.#wallTimeMs;
    if (Math.abs(delta) > this.#maxExtrapolationMs) return null;
    if (!this.#playing) return this.#mediaTimeMs;
    return Math.round(this.#mediaTimeMs + delta * this.#playbackRate);
  }

  reset(): void {
    this.#hasSample = false;
    this.#playing = false;
    this.#mediaTimeMs = 0;
  }
}
