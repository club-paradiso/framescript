/**
 * Voice activity detection.
 *
 * Energy-plus-ZCR VAD with an adaptive noise floor. Runs entirely locally and
 * is the gate for everything expensive downstream: ASR only sees speech
 * regions, diarization only clusters speech regions, and the temporal engine
 * uses speech onsets as an importance boost.
 *
 * Audio is windowed far more finely than video (20 ms vs 100 ms) because
 * speech onsets and speaker turns happen faster than screenplay-relevant
 * picture changes. The two rates are deliberately independent.
 */

import { amplitudeToDb, rms, zeroCrossingRate } from './dsp';
import type { MediaTimeMs } from '../utils/time';

export interface VadOptions {
  sampleRate: number;
  /** Analysis frame length. 20 ms is the usual speech-processing compromise. */
  frameMs?: number;
  /** Speech must exceed the noise floor by this much, in dB. */
  thresholdDb?: number;
  /** Keep the gate open this long after energy drops, to avoid clipping words. */
  hangoverMs?: number;
  /** Ignore speech regions shorter than this — they are almost always noise. */
  minSpeechMs?: number;
  /** How quickly the noise floor tracks the signal, per frame, in [0,1]. */
  floorAdaptation?: number;
  /** Above this ZCR a loud frame is treated as noise rather than voice. */
  maxVoicedZcr?: number;
}

const VAD_DEFAULTS = {
  frameMs: 20,
  thresholdDb: 9,
  hangoverMs: 300,
  minSpeechMs: 140,
  floorAdaptation: 0.03,
  maxVoicedZcr: 0.45,
} as const;

export interface VadFrame {
  timestamp: MediaTimeMs;
  db: number;
  zcr: number;
  speech: boolean;
  noiseFloorDb: number;
}

export interface SpeechRegion {
  start: MediaTimeMs;
  end: MediaTimeMs;
  /** Mean level above the noise floor across the region, in dB. */
  meanExcessDb: number;
  peakDb: number;
}

/**
 * Streaming VAD. Feed contiguous PCM chunks with their media timestamps.
 */
export class VoiceActivityDetector {
  #options: Required<VadOptions>;
  #frameSamples: number;
  #noiseFloorDb = -60;
  #initialized = false;

  #inSpeech = false;
  #speechStart: MediaTimeMs = 0;
  #lastVoiceAt: MediaTimeMs = 0;
  #excessSum = 0;
  #excessCount = 0;
  #peakDb = -100;

  #pending: Float32Array = new Float32Array(0);
  #pendingStart: MediaTimeMs = 0;

  constructor(options: VadOptions) {
    this.#options = { ...VAD_DEFAULTS, ...options };
    this.#frameSamples = Math.max(1, Math.round((this.#options.sampleRate * this.#options.frameMs) / 1000));
  }

  get noiseFloorDb(): number {
    return this.#noiseFloorDb;
  }

  get inSpeech(): boolean {
    return this.#inSpeech;
  }

  /**
   * Processes a chunk of mono PCM starting at `startTime`.
   * Returns any speech regions that *completed* within this chunk.
   */
  push(samples: Float32Array, startTime: MediaTimeMs): { frames: VadFrame[]; regions: SpeechRegion[] } {
    const combined = concat(this.#pending, samples);
    const chunkStart = this.#pending.length > 0 ? this.#pendingStart : startTime;

    const frames: VadFrame[] = [];
    const regions: SpeechRegion[] = [];
    const frameMs = this.#options.frameMs;

    let offset = 0;
    while (offset + this.#frameSamples <= combined.length) {
      const frameSamples = combined.subarray(offset, offset + this.#frameSamples);
      const timestamp = chunkStart + Math.round((offset / this.#options.sampleRate) * 1000);
      const frame = this.#processFrame(frameSamples, timestamp);
      frames.push(frame);

      const completed = this.#updateState(frame, frameMs);
      if (completed) regions.push(completed);
      offset += this.#frameSamples;
    }

    this.#pending = combined.slice(offset);
    this.#pendingStart = chunkStart + Math.round((offset / this.#options.sampleRate) * 1000);
    return { frames, regions };
  }

  /** Closes any open speech region. Call at pause/stop/seek. */
  flush(): SpeechRegion | null {
    if (!this.#inSpeech) return null;
    const region = this.#closeRegion(this.#lastVoiceAt + this.#options.frameMs);
    this.#pending = new Float32Array(0);
    return region;
  }

  reset(): void {
    this.#inSpeech = false;
    this.#pending = new Float32Array(0);
    this.#initialized = false;
    this.#noiseFloorDb = -60;
  }

  #processFrame(samples: Float32Array, timestamp: MediaTimeMs): VadFrame {
    const db = amplitudeToDb(rms(samples));
    const zcr = zeroCrossingRate(samples);

    if (!this.#initialized) {
      this.#noiseFloorDb = db;
      this.#initialized = true;
    }

    const excess = db - this.#noiseFloorDb;
    const voiced = excess >= this.#options.thresholdDb && zcr <= this.#options.maxVoicedZcr;

    // Track the floor only on non-speech frames, and let it fall faster than it
    // rises so that a loud scene does not permanently desensitize the detector.
    if (!voiced) {
      const rate = db < this.#noiseFloorDb ? this.#options.floorAdaptation * 4 : this.#options.floorAdaptation;
      this.#noiseFloorDb += (db - this.#noiseFloorDb) * rate;
    }

    return { timestamp, db, zcr, speech: voiced, noiseFloorDb: this.#noiseFloorDb };
  }

  #updateState(frame: VadFrame, frameMs: number): SpeechRegion | null {
    if (frame.speech) {
      if (!this.#inSpeech) {
        this.#inSpeech = true;
        this.#speechStart = frame.timestamp;
        this.#excessSum = 0;
        this.#excessCount = 0;
        this.#peakDb = -100;
      }
      this.#lastVoiceAt = frame.timestamp;
      this.#excessSum += frame.db - frame.noiseFloorDb;
      this.#excessCount++;
      this.#peakDb = Math.max(this.#peakDb, frame.db);
      return null;
    }

    if (this.#inSpeech && frame.timestamp - this.#lastVoiceAt >= this.#options.hangoverMs) {
      return this.#closeRegion(this.#lastVoiceAt + frameMs);
    }
    return null;
  }

  #closeRegion(end: MediaTimeMs): SpeechRegion | null {
    this.#inSpeech = false;
    const start = this.#speechStart;
    if (end - start < this.#options.minSpeechMs) return null;
    return {
      start,
      end,
      meanExcessDb: this.#excessCount > 0 ? this.#excessSum / this.#excessCount : 0,
      peakDb: this.#peakDb,
    };
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Offline convenience wrapper: runs the streaming detector over a whole buffer.
 * Used by tests and fixtures.
 */
export function detectSpeechRegions(
  samples: Float32Array,
  options: VadOptions,
  startTime: MediaTimeMs = 0,
): SpeechRegion[] {
  const vad = new VoiceActivityDetector(options);
  const { regions } = vad.push(samples, startTime);
  const tail = vad.flush();
  return tail ? [...regions, tail] : regions;
}
