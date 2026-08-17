/**
 * Media element helpers.
 *
 * FrameScript prefers standard `HTMLMediaElement` APIs to any player-private
 * JavaScript: the standard surface is stable across site redesigns, works
 * identically on both platforms, and needs no MAIN-world injection.
 */

import { secondsToMs, type MediaTimeMs } from '../../utils/time';
import { DisposableStore } from '../../utils/lifecycle';
import type { PlayerState } from '../../messaging/protocol';

/**
 * Finds the largest playing video element on the page.
 *
 * Both sites embed decorative preview videos (hover trailers, autoplay
 * thumbnails); picking the largest one with real dimensions reliably selects
 * the actual player without depending on either site's DOM structure.
 */
export function findPrimaryVideo(root: ParentNode = document): HTMLVideoElement | null {
  const videos = [...root.querySelectorAll('video')];
  if (videos.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestArea = -1;
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    // A player that has loaded metadata outranks one that has not, whatever
    // their on-screen sizes; hover previews frequently have no duration.
    const score = area + (Number.isFinite(video.duration) && video.duration > 0 ? 1_000_000 : 0);
    if (score > bestArea) {
      best = video;
      bestArea = score;
    }
  }
  return best;
}

export function readPlayerState(video: HTMLVideoElement | null): PlayerState {
  if (!video) {
    return { playing: false, currentTimeMs: 0, playbackRate: 1 };
  }
  const state: PlayerState = {
    playing: !video.paused && !video.ended && video.readyState >= 2,
    currentTimeMs: secondsToMs(video.currentTime),
    playbackRate: video.playbackRate,
  };
  if (Number.isFinite(video.duration) && video.duration > 0) {
    state.durationMs = secondsToMs(video.duration);
  }
  if (video.videoWidth > 0) {
    state.videoWidth = video.videoWidth;
    state.videoHeight = video.videoHeight;
  }
  const isProtected = isProtectedPlayback(video);
  if (isProtected !== undefined) state.protectedPlayback = isProtected;
  return state;
}

/**
 * Detects protected (DRM) playback without touching the CDM.
 *
 * Reads only the standard `mediaKeys` property, which the page sets when it has
 * attached an EME key system. FrameScript uses this purely to decide whether to
 * *expect* frame access to fail, so it can report "video unavailable" honestly
 * instead of emitting a stream of black-frame events.
 */
export function isProtectedPlayback(video: HTMLVideoElement): boolean | undefined {
  try {
    return video.mediaKeys != null;
  } catch {
    return undefined;
  }
}

export interface MediaEventCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onSeeked?: (from: MediaTimeMs, to: MediaTimeMs) => void;
  onRateChange?: (rate: number) => void;
  onEnded?: () => void;
  onResize?: (width: number, height: number) => void;
  onDurationChange?: (durationMs: MediaTimeMs) => void;
  onStalled?: () => void;
}

/**
 * Subscribes to media events with deterministic teardown.
 *
 * Seek reporting needs the position *before* the jump, which no DOM event
 * carries, so the last known time is tracked on `timeupdate`.
 */
export function observeMediaEvents(
  video: HTMLVideoElement,
  callbacks: MediaEventCallbacks,
): DisposableStore {
  const store = new DisposableStore();
  let lastTime = secondsToMs(video.currentTime);
  let seeking = false;
  let seekFrom = lastTime;

  store.addEventListener(video, 'timeupdate', () => {
    if (!seeking) lastTime = secondsToMs(video.currentTime);
  });
  store.addEventListener(video, 'seeking', () => {
    seeking = true;
    seekFrom = lastTime;
  });
  store.addEventListener(video, 'seeked', () => {
    seeking = false;
    const to = secondsToMs(video.currentTime);
    lastTime = to;
    // Sub-second scrubbing is not a narrative jump and would fragment coverage.
    if (Math.abs(to - seekFrom) > 1_000) callbacks.onSeeked?.(seekFrom, to);
  });

  if (callbacks.onPlay) store.addEventListener(video, 'play', callbacks.onPlay);
  if (callbacks.onPause) store.addEventListener(video, 'pause', callbacks.onPause);
  if (callbacks.onEnded) store.addEventListener(video, 'ended', callbacks.onEnded);
  if (callbacks.onStalled) store.addEventListener(video, 'stalled', callbacks.onStalled);
  if (callbacks.onRateChange) {
    store.addEventListener(video, 'ratechange', () => callbacks.onRateChange?.(video.playbackRate));
  }
  if (callbacks.onResize) {
    store.addEventListener(video, 'resize', () => callbacks.onResize?.(video.videoWidth, video.videoHeight));
  }
  if (callbacks.onDurationChange) {
    store.addEventListener(video, 'durationchange', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        callbacks.onDurationChange?.(secondsToMs(video.duration));
      }
    });
  }
  return store;
}

/**
 * Watches for the player element being replaced.
 *
 * Both sites tear down and recreate their `<video>` on navigation, so holding a
 * stale reference is the single most common source of "FrameScript stopped
 * working after I clicked the next episode".
 */
export function observeVideoReplacement(
  current: HTMLVideoElement,
  onReplaced: (next: HTMLVideoElement | null) => void,
): () => void {
  const observer = new MutationObserver(() => {
    if (current.isConnected) return;
    observer.disconnect();
    onReplaced(findPrimaryVideo());
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/**
 * Frame-accurate observation via `requestVideoFrameCallback`.
 *
 * When available this gives the browser's own presented-frame timing, which is
 * what Forensic mode needs — it is exact rather than a polling approximation.
 * Returns null when the API is absent so callers can fall back to an interval.
 */
export function observePresentedFrames(
  video: HTMLVideoElement,
  onFrame: (mediaTimeMs: MediaTimeMs, metadata: VideoFrameCallbackMetadata) => void,
): (() => void) | null {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;

  let handle: number | null = null;
  let cancelled = false;

  const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
    if (cancelled) return;
    onFrame(secondsToMs(metadata.mediaTime), metadata);
    handle = video.requestVideoFrameCallback(tick);
  };
  handle = video.requestVideoFrameCallback(tick);

  return () => {
    cancelled = true;
    if (handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(handle);
    }
  };
}

/** Measured presentation frame rate, from consecutive frame metadata. */
export class FrameRateEstimator {
  #lastMediaTime: number | null = null;
  #intervals: number[] = [];
  #maxSamples: number;

  constructor(maxSamples = 60) {
    this.#maxSamples = maxSamples;
  }

  sample(mediaTimeMs: MediaTimeMs): void {
    if (this.#lastMediaTime !== null) {
      const delta = mediaTimeMs - this.#lastMediaTime;
      // Ignore seeks and repeated frames; neither describes the frame rate.
      if (delta > 0 && delta < 500) {
        this.#intervals.push(delta);
        if (this.#intervals.length > this.#maxSamples) this.#intervals.shift();
      }
    }
    this.#lastMediaTime = mediaTimeMs;
  }

  /** Median-based estimate, robust to the occasional dropped frame. */
  estimate(): number | undefined {
    if (this.#intervals.length < 5) return undefined;
    const sorted = [...this.#intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return median > 0 ? Math.round((1000 / median) * 100) / 100 : undefined;
  }

  reset(): void {
    this.#lastMediaTime = null;
    this.#intervals = [];
  }
}
