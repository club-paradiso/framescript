/**
 * Video analysis pipeline.
 *
 * Drives the temporal scanner from the captured tab video, at the profile's
 * observation rate (100 ms in Detailed mode), and assembles deep-analysis
 * requests as ordered *frame sequences* rather than isolated stills.
 *
 * Playback resolution and analysis resolution are entirely separate: the film
 * plays at whatever the Maximum Quality engine achieved, while analysis works
 * from a downscaled copy. Nothing here can lower playback quality.
 *
 * On protected playback, canvas readback yields black frames. The scanner
 * detects that and this pipeline reports the video source as
 * `protected-content` — it does not attempt, and contains no code that could
 * attempt, to read protected pixels.
 */

import { createIdFactory } from '../utils/id';
import type { MediaTimeMs } from '../utils/time';
import type { EvidenceEvent, VisualEvidence } from '../evidence/types';
import { fromScore } from '../evidence/confidence';
import { TemporalScanner, type DeepAnalysisRequest } from '../temporal/TemporalScanner';
import { ActionSegmenter } from '../temporal/ActionSegmenter';
import { KeyframeBuffer, toFrameRef } from '../temporal/KeyframeBuffer';
import type { FidelityProfile } from '../temporal/fidelity';
import { FrameRateEstimator } from '../platforms/shared/media';
import type { MediaClock } from './mediaClock';
import type { VisionFrame } from '../ai/types';

export interface VideoPipelineOptions {
  clock: MediaClock;
  profile: FidelityProfile;
  emit: (events: EvidenceEvent[]) => void;
  /** Called with an ordered frame sequence for a window worth analyzing. */
  onDeepAnalysis?: (request: DeepAnalysisRequest, frames: VisionFrame[]) => void;
  onProtectedContent?: () => void;
  /** JPEG quality for keyframes handed to a provider. */
  keyframeQuality?: number;
}

export interface VideoPipelineStats {
  observations: number;
  emittedEvents: number;
  redundantSkipped: number;
  deepRequests: number;
  sceneCuts: number;
  observedFps: number;
  mediaFps?: number;
  keyframeBytes: number;
  droppedKeyframes: number;
}

const nextId = createIdFactory('vis');

export class VideoPipeline {
  #options: VideoPipelineOptions;
  #video: HTMLVideoElement | null = null;
  #canvas: OffscreenCanvas | null = null;
  #context: OffscreenCanvasRenderingContext2D | null = null;
  #scanner: TemporalScanner;
  #segmenter = new ActionSegmenter();
  #keyframes: KeyframeBuffer;
  #frameRate = new FrameRateEstimator();

  #stream: MediaStream | null = null;
  #cancelFrameLoop: (() => void) | null = null;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #paused = false;
  #protectedReported = false;
  #lastObservationAt = -Infinity;
  #encodeInFlight = false;

  constructor(options: VideoPipelineOptions) {
    this.#options = options;
    this.#keyframes = new KeyframeBuffer(options.profile.keyframeBufferSize);
    this.#scanner = new TemporalScanner({
      profile: options.profile,
      callbacks: {
        onTemporalEvent: (event) => {
          const segment = this.#segmenter.push(event);
          if (segment) {
            this.#emitSegment(segment.start, segment.end, segment.peakImportance, segment.hesitations.length);
          }
        },
        onSceneCut: (timestamp, score) => this.#emitSceneCut(timestamp, score),
        onDeepAnalysisRequest: (request) => void this.#handleDeepRequest(request),
        onBlankFramesDetected: () => {
          if (this.#protectedReported) return;
          this.#protectedReported = true;
          this.#options.onProtectedContent?.();
        },
      },
    });
  }

  get running(): boolean {
    return this.#running;
  }

  get stats(): VideoPipelineStats {
    const s = this.#scanner.stats;
    return {
      observations: s.observations,
      emittedEvents: s.emittedEvents,
      redundantSkipped: s.redundantSkipped,
      deepRequests: s.deepRequests,
      sceneCuts: s.sceneCuts,
      observedFps: Math.round(s.observedFps * 100) / 100,
      ...(this.#frameRate.estimate() === undefined ? {} : { mediaFps: this.#frameRate.estimate()! }),
      keyframeBytes: this.#keyframes.byteLength,
      droppedKeyframes: this.#keyframes.droppedCount,
    };
  }

  /**
   * Starts observing.
   *
   * Returns false when the captured stream has no video track, which is a
   * normal outcome (audio-only capture) and not an error.
   */
  async start(stream: MediaStream): Promise<boolean> {
    if (this.#running) return true;
    if (stream.getVideoTracks().length === 0) return false;

    this.#stream = stream;
    const video = document.createElement('video');
    video.srcObject = stream;
    // Muted is essential: the audio path is the Web Audio graph, and an
    // unmuted element here would double the sound.
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => undefined);
    this.#video = video;

    const { analysisWidth, analysisHeight } = this.#options.profile;
    this.#canvas = new OffscreenCanvas(analysisWidth, analysisHeight);
    this.#context = this.#canvas.getContext('2d', { willReadFrequently: true });
    if (!this.#context) return false;

    this.#running = true;
    this.#startObservationLoop(video);
    return true;
  }

  pause(): void {
    this.#paused = true;
    const segment = this.#segmenter.flush();
    if (segment) {
      this.#emitSegment(segment.start, segment.end, segment.peakImportance, segment.hesitations.length);
    }
    // Retained frames have no value while paused and are dropped immediately.
    this.#keyframes.clear();
  }

  resume(): void {
    this.#paused = false;
    this.#scanner.resetContinuity();
  }

  /** Call after a seek so frames either side of the jump are not diffed. */
  handleSeek(): void {
    this.#scanner.resetContinuity();
    this.#segmenter.flush();
    this.#keyframes.clear();
    this.#frameRate.reset();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#cancelFrameLoop?.();
    this.#cancelFrameLoop = null;
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }

    this.#segmenter.flush();
    this.#keyframes.clear();

    if (this.#video) {
      this.#video.pause();
      this.#video.srcObject = null;
      this.#video.remove();
      this.#video = null;
    }
    for (const track of this.#stream?.getVideoTracks() ?? []) track.stop();
    this.#stream = null;
    this.#canvas = null;
    this.#context = null;
  }

  /**
   * Chooses the observation driver.
   *
   * Forensic mode uses `requestVideoFrameCallback`, which reports every frame
   * the browser actually presented — exact rather than approximated. The other
   * profiles use an interval at their target period, because observing more
   * often than the profile asks for would waste the budget the whole design is
   * built to protect.
   */
  #startObservationLoop(video: HTMLVideoElement): void {
    const intervalMs = this.#options.profile.temporalIntervalMs;

    if (intervalMs === 0 && typeof video.requestVideoFrameCallback === 'function') {
      let handle: number | null = null;
      let cancelled = false;

      const tick = () => {
        if (cancelled) return;
        this.#observe();
        handle = video.requestVideoFrameCallback(tick);
      };
      handle = video.requestVideoFrameCallback(tick);

      this.#cancelFrameLoop = () => {
        cancelled = true;
        if (handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(handle);
        }
      };
      return;
    }

    const period = intervalMs > 0 ? intervalMs : 100;
    this.#intervalHandle = setInterval(() => this.#observe(), period);
  }

  #observe(): void {
    if (!this.#running || this.#paused) return;
    const video = this.#video;
    const context = this.#context;
    const canvas = this.#canvas;
    if (!video || !context || !canvas || video.readyState < 2) return;

    const mediaTime = this.#options.clock.now();
    if (mediaTime === null) return;

    // Guard against the interval firing faster than the profile asks for
    // (timer coalescing can deliver bursts after the tab regains focus).
    const minGap = this.#options.profile.temporalIntervalMs * 0.5;
    if (minGap > 0 && mediaTime - this.#lastObservationAt < minGap) return;
    this.#lastObservationAt = mediaTime;
    this.#frameRate.sample(mediaTime);

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      this.#scanner.observe({
        data: image.data,
        width: canvas.width,
        height: canvas.height,
        timestamp: mediaTime,
      });
    } catch {
      // A tainted or protected surface throws on readback. Report once and
      // stop trying rather than throwing ten times a second.
      if (!this.#protectedReported) {
        this.#protectedReported = true;
        this.#options.onProtectedContent?.();
      }
      this.#cancelFrameLoop?.();
      if (this.#intervalHandle !== null) {
        clearInterval(this.#intervalHandle);
        this.#intervalHandle = null;
      }
      return;
    }

    void this.#captureKeyframe(mediaTime);
  }

  /**
   * Encodes a keyframe into the bounded ring.
   *
   * Only one encode is allowed in flight: encoding is the most expensive thing
   * this pipeline does, and letting encodes queue is how analysis starts
   * stealing time from playback.
   */
  async #captureKeyframe(timestamp: MediaTimeMs): Promise<void> {
    if (this.#encodeInFlight || !this.#canvas) return;
    if (!this.#options.onDeepAnalysis) return;

    this.#encodeInFlight = true;
    try {
      const blob = await this.#canvas.convertToBlob({
        type: 'image/jpeg',
        quality: this.#options.keyframeQuality ?? 0.6,
      });
      const data = new Uint8Array(await blob.arrayBuffer());
      this.#keyframes.push({
        timestamp,
        width: this.#canvas.width,
        height: this.#canvas.height,
        data,
        mimeType: 'image/jpeg',
      });
    } catch {
      // Encoding failure is non-fatal: local temporal analysis continues, only
      // provider-backed deep analysis loses its frames.
    } finally {
      this.#encodeInFlight = false;
    }
  }

  /**
   * Builds the frame sequence for a deep-analysis window.
   *
   * The window reaches *backwards* from the trigger, because the interesting
   * part of an action is how it arrived at the salient moment, not what follows.
   */
  async #handleDeepRequest(request: DeepAnalysisRequest): Promise<void> {
    const onDeep = this.#options.onDeepAnalysis;
    if (!onDeep) return;

    const windowMs = 1_200;
    const frames = this.#keyframes.sampleWindow(request.timestamp - windowMs, request.timestamp, 8);
    if (frames.length === 0) return;

    onDeep(
      request,
      frames.map((frame) => ({
        timestamp: frame.timestamp,
        data: frame.data,
        mimeType: frame.mimeType,
        width: frame.width,
        height: frame.height,
      })),
    );
  }

  #emitSceneCut(timestamp: MediaTimeMs, score: number): void {
    const event: VisualEvidence = {
      id: nextId(),
      source: 'video',
      start: timestamp,
      confidence: fromScore(score, { strongEvidence: true }),
      provisional: false,
      payload: { kind: 'scene-change', metrics: { sceneCutScore: score } },
    };
    this.#options.emit([event]);
  }

  /**
   * Emits one action segment as visual evidence.
   *
   * No description is attached here. Local heuristics measure *change*, not
   * meaning, so the description is left for a vision provider to fill in; the
   * fusion layer omits description-less action rather than inventing prose.
   */
  #emitSegment(
    start: MediaTimeMs,
    end: MediaTimeMs,
    peakImportance: number,
    hesitationCount: number,
  ): void {
    const frames = this.#keyframes.range(start, end).slice(0, 4).map(toFrameRef);
    const event: VisualEvidence = {
      id: nextId(),
      source: 'video',
      start,
      end,
      confidence: fromScore(peakImportance),
      provisional: true,
      payload: {
        kind: 'action',
        metrics: { motionScore: peakImportance },
        ...(frames.length > 0 ? { frameRefs: frames } : {}),
        ...(hesitationCount > 0 ? { hesitationCount } : {}),
      },
    };
    this.#options.emit([event]);
  }
}
