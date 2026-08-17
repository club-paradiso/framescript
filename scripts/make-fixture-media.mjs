#!/usr/bin/env node
/**
 * Generates deterministic fixture media for end-to-end analysis tests.
 *
 * There is no ffmpeg in this environment, and shipping a real film clip would
 * put copyrighted media in the repository. So the fixture is synthesised from
 * first principles: a WAV whose structure is known exactly, which makes the
 * assertions about it precise rather than approximate.
 *
 * Structure of `fixture-speech.wav` (16 kHz mono, ~14 s):
 *
 *   0.0 -  2.0   near-silence            (establishes the noise floor)
 *   2.0 -  4.0   voice A (120 Hz + harmonics)
 *   4.0 -  8.0   near-silence            (a long, "significant" pause)
 *   8.0 - 10.0   voice B (260 Hz + harmonics)
 *  10.0 - 10.15  broadband impact        (a percussive sound event)
 *  10.15- 14.0   near-silence
 *
 * Expected from the engine: 2 speech regions, 2 speaker clusters, at least one
 * sound event, and one significant silence between the two utterances.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../tests/fixtures', import.meta.url));
const SAMPLE_RATE = 16_000;

/** Deterministic pseudo-random noise; a fixture must never flake. */
function noise(target, from, to, amplitude, seed) {
  let state = seed >>> 0;
  for (let i = from; i < to; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    target[i] += ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
}

/**
 * A voiced-speech surrogate: a fundamental with two harmonics, amplitude
 * modulated at ~5 Hz to imitate syllable rate. Harmonic structure gives the low
 * zero-crossing rate the VAD keys on; the differing fundamentals give the
 * diarizer two distinguishable spectral envelopes.
 */
function voice(target, from, to, fundamental, amplitude) {
  for (let i = from; i < to; i++) {
    const t = i / SAMPLE_RATE;
    const syllable = 0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t);
    target[i] +=
      amplitude *
      syllable *
      ((Math.sin(2 * Math.PI * fundamental * t) +
        0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t) +
        0.25 * Math.sin(2 * Math.PI * fundamental * 3 * t)) /
        1.75);
  }
}

const sec = (s) => Math.round(s * SAMPLE_RATE);

function buildSpeechFixture() {
  const total = sec(14);
  const samples = new Float32Array(total);

  // A quiet noise floor throughout, so the VAD has something to adapt to.
  noise(samples, 0, total, 0.002, 7);

  voice(samples, sec(2), sec(4), 120, 0.45);
  voice(samples, sec(8), sec(10), 260, 0.45);

  // Percussive broadband burst with a fast decay.
  const impactFrom = sec(10);
  const impactTo = sec(10.15);
  noise(samples, impactFrom, impactTo, 0.9, 31);
  for (let i = impactFrom; i < impactTo; i++) {
    samples[i] *= 1 - (i - impactFrom) / (impactTo - impactFrom);
  }

  return samples;
}

/** 16-bit mono WAV. Mirrors `encodeWav` in src/audio/dsp.ts. */
function encodeWav(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples.length * 2, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

mkdirSync(OUT_DIR, { recursive: true });
const wav = encodeWav(buildSpeechFixture(), SAMPLE_RATE);
writeFileSync(resolve(OUT_DIR, 'fixture-speech.wav'), wav);
console.log(`wrote fixture-speech.wav (${(wav.length / 1024).toFixed(1)} KB, 14 s, ${SAMPLE_RATE} Hz mono)`);
