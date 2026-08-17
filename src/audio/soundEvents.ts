/**
 * Non-speech sound events.
 *
 * Honesty note, because this is the easiest place in the product to overclaim:
 * a handful of spectral features cannot reliably tell a door slam from a
 * gunshot. So the local detector's job is to find *that something happened*
 * (onset detection, which it does well) and to classify only where the acoustic
 * evidence is genuinely distinctive. Everything else is emitted as
 * `unclassified` with low confidence, and a configured sound-event provider can
 * do better if the user enables one.
 *
 * Emitting "unclassified impact" is correct. Emitting "gunshot" because
 * something was loud would not be.
 */

import type { SoundEventKind } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';
import { amplitudeToDb, magnitudeSpectrum, rms, spectralCentroid, spectralFlatness, spectralFlux } from './dsp';

export interface SoundOnset {
  timestamp: MediaTimeMs;
  /** Loudness above the running background level, in dB. */
  prominenceDb: number;
  kind: SoundEventKind;
  /** Attack sharpness in [0,1]; percussive events rise fast. */
  attack: number;
  centroidHz: number;
  flatness: number;
  /** How much this classification should be trusted. */
  classified: boolean;
}

export interface SoundEventOptions {
  sampleRate: number;
  frameMs?: number;
  /** Minimum prominence over background to report an onset at all. */
  minProminenceDb?: number;
  /** Minimum spacing between reported onsets. */
  minSpacingMs?: number;
  /** Background level adaptation rate per frame. */
  backgroundAdaptation?: number;
}

const SOUND_DEFAULTS = {
  frameMs: 25,
  minProminenceDb: 10,
  minSpacingMs: 250,
  backgroundAdaptation: 0.05,
} as const;

/**
 * Streaming onset detector.
 *
 * Uses spectral flux for onset timing (accurate) plus level, centroid and
 * flatness for the conservative classification pass.
 */
export class SoundEventDetector {
  #options: Required<SoundEventOptions>;
  #frameSamples: number;
  #previousSpectrum: Float32Array | null = null;
  #backgroundDb = -60;
  #initialized = false;
  #lastOnsetAt = -Infinity;
  #musicActive = false;
  #tonalStreak = 0;
  #pending = new Float32Array(0);
  #pendingStart: MediaTimeMs = 0;

  constructor(options: SoundEventOptions) {
    this.#options = { ...SOUND_DEFAULTS, ...options };
    this.#frameSamples = Math.max(64, Math.round((this.#options.sampleRate * this.#options.frameMs) / 1000));
  }

  get backgroundDb(): number {
    return this.#backgroundDb;
  }

  get musicActive(): boolean {
    return this.#musicActive;
  }

  push(samples: Float32Array, startTime: MediaTimeMs): SoundOnset[] {
    const combined = concat(this.#pending, samples);
    const chunkStart = this.#pending.length > 0 ? this.#pendingStart : startTime;
    const out: SoundOnset[] = [];

    let offset = 0;
    while (offset + this.#frameSamples <= combined.length) {
      const frame = combined.subarray(offset, offset + this.#frameSamples);
      const timestamp = chunkStart + Math.round((offset / this.#options.sampleRate) * 1000);
      const event = this.#processFrame(frame, timestamp);
      if (event) out.push(event);
      offset += this.#frameSamples;
    }

    this.#pending = combined.slice(offset);
    this.#pendingStart = chunkStart + Math.round((offset / this.#options.sampleRate) * 1000);
    return out;
  }

  reset(): void {
    this.#previousSpectrum = null;
    this.#initialized = false;
    this.#musicActive = false;
    this.#tonalStreak = 0;
    this.#pending = new Float32Array(0);
  }

  #processFrame(samples: Float32Array, timestamp: MediaTimeMs): SoundOnset | null {
    const level = amplitudeToDb(rms(samples));
    const spectrum = magnitudeSpectrum(samples);
    const flatness = spectralFlatness(spectrum);
    const centroidHz = spectralCentroid(spectrum, this.#options.sampleRate);

    if (!this.#initialized) {
      this.#backgroundDb = level;
      this.#initialized = true;
      this.#previousSpectrum = spectrum;
      return null;
    }

    const previous = this.#previousSpectrum;
    this.#previousSpectrum = spectrum;
    const flux = previous ? spectralFlux(previous, spectrum) : 0;
    const prominenceDb = level - this.#backgroundDb;

    const musicEvent = this.#trackMusic(flatness, level, timestamp);

    if (prominenceDb < this.#options.minProminenceDb) {
      this.#backgroundDb += (level - this.#backgroundDb) * this.#options.backgroundAdaptation;
      return musicEvent;
    }
    if (timestamp - this.#lastOnsetAt < this.#options.minSpacingMs) return musicEvent;

    this.#lastOnsetAt = timestamp;
    // Flux normalized by frame level gives an attack sharpness independent of volume.
    const attack = Math.min(1, flux / Math.max(1e-6, sum(spectrum) * 0.5));
    const { kind, classified } = classifyOnset({ prominenceDb, attack, centroidHz, flatness });

    return { timestamp, prominenceDb, kind, attack, centroidHz, flatness, classified };
  }

  /**
   * Music start/end detection.
   *
   * Sustained low flatness (tonal content) at an audible level is the most
   * reliable local music cue. FrameScript reports only that music started,
   * swelled or ended — it never transcribes lyrics.
   */
  #trackMusic(flatness: number, level: number, timestamp: MediaTimeMs): SoundOnset | null {
    const tonal = flatness < 0.16 && level > this.#backgroundDb - 6 && level > -50;
    this.#tonalStreak = tonal ? this.#tonalStreak + 1 : Math.max(0, this.#tonalStreak - 1);

    const framesPerSecond = 1000 / this.#options.frameMs;
    if (!this.#musicActive && this.#tonalStreak > framesPerSecond * 2) {
      this.#musicActive = true;
      return makeMusicEvent('music-start', timestamp, level - this.#backgroundDb, flatness);
    }
    if (this.#musicActive && this.#tonalStreak === 0) {
      this.#musicActive = false;
      return makeMusicEvent('music-end', timestamp, level - this.#backgroundDb, flatness);
    }
    return null;
  }
}

function makeMusicEvent(
  kind: SoundEventKind,
  timestamp: MediaTimeMs,
  prominenceDb: number,
  flatness: number,
): SoundOnset {
  return { timestamp, prominenceDb, kind, attack: 0, centroidHz: 0, flatness, classified: true };
}

export interface OnsetFeatures {
  prominenceDb: number;
  attack: number;
  centroidHz: number;
  flatness: number;
}

/**
 * Conservative classification.
 *
 * Only three categories are claimed locally, each with a distinctive acoustic
 * signature. Everything else returns `unclassified`, which the screenplay
 * renders as a neutral phrase rather than a specific noun.
 */
export function classifyOnset(features: OnsetFeatures): { kind: SoundEventKind; classified: boolean } {
  const { prominenceDb, attack, centroidHz, flatness } = features;

  // Broadband, very sharp, very loud: a percussive impact. We say "impact",
  // not "gunshot" — those are not separable from these features.
  if (attack > 0.5 && flatness > 0.4 && prominenceDb > 18) {
    return { kind: 'impact', classified: true };
  }
  // Sustained, strongly tonal, mid-high centroid: a ring or alarm tone.
  if (flatness < 0.1 && centroidHz > 700 && centroidHz < 4_000 && attack < 0.35) {
    return { kind: 'alarm', classified: true };
  }
  // Broadband and noisy but with a soft attack: crowd noise / applause-like.
  if (flatness > 0.6 && attack < 0.3 && prominenceDb > 12) {
    return { kind: 'applause', classified: true };
  }
  return { kind: 'unclassified', classified: false };
}

/** Screenplay phrasing. Vague on purpose where the evidence is vague. */
export function describeSoundEvent(kind: SoundEventKind, description?: string): string {
  if (description) return description;
  switch (kind) {
    case 'door':
      return 'A door opens.';
    case 'knock':
      return 'A knock at the door.';
    case 'footsteps':
      return 'Footsteps approach.';
    case 'phone':
      return 'A phone rings.';
    case 'alarm':
      return 'An alarm sounds.';
    case 'glass':
      return 'Glass breaks.';
    case 'gunshot':
      return 'A gunshot cracks.';
    case 'vehicle':
      return 'A vehicle passes.';
    case 'laughter':
      return 'Laughter.';
    case 'applause':
      return 'Applause.';
    case 'impact':
      return 'A sharp impact.';
    case 'music-start':
      return 'Music begins.';
    case 'music-end':
      return 'The music fades.';
    case 'music-swell':
      return 'The music swells.';
    case 'ambience-change':
      return 'The ambience shifts.';
    case 'unclassified':
      return 'A sudden sound.';
  }
}

function sum(values: Float32Array): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
