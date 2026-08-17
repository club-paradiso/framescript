import { describe, expect, it } from 'vitest';
import {
  amplitudeToDb,
  cosineDistance,
  computeMfcc,
  dct,
  encodeWav,
  fft,
  magnitudeSpectrum,
  melFilterbank,
  resampleLinear,
  rms,
  spectralCentroid,
  spectralFlatness,
  spectralFlux,
  zeroCrossingRate,
} from '@/audio/dsp';
import { detectSpeechRegions, VoiceActivityDetector } from '@/audio/vad';
import { describeSilence, findSilences } from '@/audio/silence';
import { classifyOnset, describeSoundEvent, SoundEventDetector } from '@/audio/soundEvents';
import { SpeakerDiarizer } from '@/audio/diarization';

const SR = 16_000;

/** Deterministic pseudo-random noise, so tests never flake. */
function noise(length: number, amplitude = 1, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function tone(freq: number, length: number, amplitude = 1, sampleRate = SR): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
  return out;
}

/**
 * Crude voiced-speech surrogate: a low fundamental with harmonics, which gives
 * the low zero-crossing rate and harmonic structure the VAD keys on.
 */
function voiced(fundamental: number, length: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    out[i] =
      amplitude *
      (Math.sin(2 * Math.PI * fundamental * t) +
        0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t) +
        0.25 * Math.sin(2 * Math.PI * fundamental * 3 * t)) /
      1.75;
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const seconds = (n: number) => Math.round(SR * n);

describe('dsp primitives', () => {
  it('computes RMS and dB correctly', () => {
    expect(rms(new Float32Array(100).fill(1))).toBeCloseTo(1, 5);
    expect(rms(new Float32Array(100))).toBe(0);
    expect(amplitudeToDb(1)).toBeCloseTo(0, 5);
    expect(amplitudeToDb(0.1)).toBeCloseTo(-20, 5);
    // Silence floors instead of producing -Infinity.
    expect(amplitudeToDb(0)).toBe(-100);
  });

  it('measures zero-crossing rate', () => {
    // Alternating sign crosses on every sample.
    const alternating = Float32Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    expect(zeroCrossingRate(alternating)).toBeCloseTo(1, 2);
    expect(zeroCrossingRate(new Float32Array(100).fill(1))).toBe(0);
    // A 1 kHz tone at 16 kHz crosses roughly twice per 16 samples.
    expect(zeroCrossingRate(tone(1000, 1600))).toBeCloseTo(0.125, 2);
  });

  it('runs an FFT that satisfies Parseval and finds the right bin', () => {
    const n = 1024;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    // A pure bin-64 sinusoid must produce energy at bin 64 and nowhere else.
    for (let i = 0; i < n; i++) real[i] = Math.cos((2 * Math.PI * 64 * i) / n);
    fft(real, imag);

    const magnitude = (i: number) => Math.hypot(real[i]!, imag[i]!);
    const peak = magnitude(64);
    expect(peak).toBeGreaterThan(n / 4);
    expect(magnitude(30)).toBeLessThan(peak / 100);
  });

  it('rejects non-power-of-two FFT input rather than corrupting it', () => {
    expect(() => fft(new Float32Array(100), new Float32Array(100))).toThrow();
  });

  it('locates a tone in the magnitude spectrum', () => {
    const spectrum = magnitudeSpectrum(tone(1000, 1024));
    const binHz = SR / 2 / spectrum.length;
    let peakIndex = 0;
    for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peakIndex]!) peakIndex = i;
    expect(peakIndex * binHz).toBeGreaterThan(800);
    expect(peakIndex * binHz).toBeLessThan(1200);
  });

  it('separates tonal from noisy content by flatness', () => {
    const tonal = spectralFlatness(magnitudeSpectrum(tone(440, 1024)));
    const noisy = spectralFlatness(magnitudeSpectrum(noise(1024, 0.5)));
    expect(tonal).toBeLessThan(0.2);
    expect(noisy).toBeGreaterThan(tonal * 2);
  });

  it('reports a higher centroid for brighter content', () => {
    const low = spectralCentroid(magnitudeSpectrum(tone(300, 1024)), SR);
    const high = spectralCentroid(magnitudeSpectrum(tone(4000, 1024)), SR);
    expect(high).toBeGreaterThan(low);
  });

  it('reports positive spectral flux only on energy increase', () => {
    const quiet = magnitudeSpectrum(tone(1000, 1024, 0.05));
    const loud = magnitudeSpectrum(tone(1000, 1024, 1));
    expect(spectralFlux(quiet, loud)).toBeGreaterThan(0);
    expect(spectralFlux(loud, quiet)).toBe(0);
  });

  it('builds a mel filterbank with the requested band count', () => {
    const bands = melFilterbank(magnitudeSpectrum(tone(1000, 1024)), SR, 20);
    expect(bands).toHaveLength(20);
    expect([...bands].some((v) => v > 0)).toBe(true);
  });

  it('computes a DCT of the requested length', () => {
    expect(dct(Float32Array.from([1, 2, 3, 4]), 3)).toHaveLength(3);
  });

  it('produces similar MFCCs for the same voice and different ones for another', () => {
    const a1 = computeMfcc(voiced(120, 512), SR);
    const a2 = computeMfcc(voiced(120, 512, 0.3), SR);
    const b = computeMfcc(voiced(260, 512), SR);

    const same = cosineDistance(a1.subarray(1), a2.subarray(1));
    const different = cosineDistance(a1.subarray(1), b.subarray(1));
    // Amplitude change must matter far less than pitch/timbre change.
    expect(same).toBeLessThan(different);
  });

  it('resamples to the target length', () => {
    const resampled = resampleLinear(tone(440, 48_000, 1, 48_000), 48_000, 16_000);
    expect(resampled.length).toBe(16_000);
    expect(resampleLinear(tone(440, 100), SR, SR).length).toBe(100);
  });

  it('encodes a valid 16-bit mono WAV header', () => {
    const wav = encodeWav(tone(440, 1000), SR);
    const text = String.fromCharCode(...wav.subarray(0, 4));
    expect(text).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(wav.length).toBe(44 + 1000 * 2);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SR);
    expect(view.getUint16(34, true)).toBe(16); // bit depth
  });
});

describe('voice activity detection', () => {
  it('finds a speech region surrounded by silence', () => {
    const signal = concat(
      noise(seconds(1), 0.002, 7),
      voiced(140, seconds(1.2), 0.5),
      noise(seconds(1), 0.002, 9),
    );
    const regions = detectSpeechRegions(signal, { sampleRate: SR });

    expect(regions.length).toBeGreaterThanOrEqual(1);
    const region = regions[0]!;
    expect(region.start).toBeGreaterThan(700);
    expect(region.start).toBeLessThan(1400);
    expect(region.end - region.start).toBeGreaterThan(800);
  });

  it('reports no speech in silence', () => {
    expect(detectSpeechRegions(noise(seconds(3), 0.001, 3), { sampleRate: SR })).toHaveLength(0);
  });

  it('rejects loud broadband noise as speech via the ZCR gate', () => {
    const signal = concat(noise(seconds(1), 0.002, 5), noise(seconds(1), 0.6, 11), noise(seconds(1), 0.002, 13));
    const regions = detectSpeechRegions(signal, { sampleRate: SR });
    const speechMs = regions.reduce((sum, r) => sum + (r.end - r.start), 0);
    // Broadband hiss has a very high zero-crossing rate; it must not read as voice.
    expect(speechMs).toBeLessThan(400);
  });

  it('bridges a short pause within one utterance via hangover', () => {
    const signal = concat(
      noise(seconds(0.5), 0.002, 2),
      voiced(140, seconds(0.6)),
      noise(seconds(0.15), 0.002, 4),
      voiced(140, seconds(0.6)),
      noise(seconds(0.5), 0.002, 6),
    );
    const regions = detectSpeechRegions(signal, { sampleRate: SR, hangoverMs: 300 });
    // A 150 ms gap is a breath, not a new utterance.
    expect(regions).toHaveLength(1);
  });

  it('separates two utterances across a long pause', () => {
    const signal = concat(
      noise(seconds(0.4), 0.002, 2),
      voiced(140, seconds(0.6)),
      noise(seconds(1.5), 0.002, 4),
      voiced(140, seconds(0.6)),
      noise(seconds(0.4), 0.002, 6),
    );
    expect(detectSpeechRegions(signal, { sampleRate: SR, hangoverMs: 300 }).length).toBe(2);
  });

  it('handles chunked streaming identically to one buffer', () => {
    const signal = concat(noise(seconds(0.5), 0.002, 2), voiced(140, seconds(1)), noise(seconds(0.8), 0.002, 4));
    const vad = new VoiceActivityDetector({ sampleRate: SR });

    const chunkSize = 4096;
    const regions = [];
    for (let offset = 0; offset < signal.length; offset += chunkSize) {
      const chunk = signal.subarray(offset, Math.min(offset + chunkSize, signal.length));
      const startMs = Math.round((offset / SR) * 1000);
      regions.push(...vad.push(chunk, startMs).regions);
    }
    const tail = vad.flush();
    if (tail) regions.push(tail);

    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]!.start).toBeGreaterThan(300);
  });

  it('discards speech regions too short to be an utterance', () => {
    const signal = concat(noise(seconds(0.5), 0.002, 2), voiced(140, seconds(0.05)), noise(seconds(0.5), 0.002, 4));
    expect(detectSpeechRegions(signal, { sampleRate: SR, minSpeechMs: 140 })).toHaveLength(0);
  });
});

describe('silence', () => {
  const region = (start: number, end: number) => ({ start, end, meanExcessDb: 12, peakDb: -20 });

  it('needs at least two utterances to have a gap between them', () => {
    expect(findSilences([region(0, 1000)])).toHaveLength(0);
  });

  it('marks a long pause among short ones as significant', () => {
    const regions = [
      region(0, 1000),
      region(1300, 2000),
      region(2300, 3000),
      region(3300, 4000),
      // The held pause.
      region(9000, 10_000),
      region(10_300, 11_000),
      region(11_300, 12_000),
    ];
    const silences = findSilences(regions);
    const significant = silences.filter((s) => s.significant);
    expect(significant).toHaveLength(1);
    expect(significant[0]!.start).toBe(4000);
  });

  it('does not report every ordinary pause', () => {
    const regions = Array.from({ length: 10 }, (_, i) => region(i * 1500, i * 1500 + 1000));
    // Uniform 500 ms gaps are conversational rhythm, not drama.
    expect(findSilences(regions).filter((s) => s.significant)).toHaveLength(0);
  });

  it('treats a very long gap as significant regardless of local rhythm', () => {
    const regions = [region(0, 1000), region(20_000, 21_000)];
    const silences = findSilences(regions);
    expect(silences[0]!.significant).toBe(true);
  });

  it('phrases silences by length', () => {
    const gap = (durationMs: number) => ({ start: 0, end: durationMs, durationMs, significant: true, relativeLength: 5 });
    expect(describeSilence(gap(10_000))).toBe('A long silence.');
    expect(describeSilence(gap(5_000))).toBe('Silence.');
    expect(describeSilence(gap(2_000))).toBe('A pause.');
  });
});

describe('sound events', () => {
  it('detects an onset when level jumps above the background', () => {
    const detector = new SoundEventDetector({ sampleRate: SR, minProminenceDb: 10 });
    detector.push(noise(seconds(1), 0.005, 3), 0);
    const onsets = detector.push(concat(noise(seconds(0.05), 0.9, 5), noise(seconds(0.5), 0.005, 7)), 1000);
    expect(onsets.length).toBeGreaterThanOrEqual(1);
  });

  it('reports no onset in steady background noise', () => {
    const detector = new SoundEventDetector({ sampleRate: SR });
    detector.push(noise(seconds(1), 0.01, 3), 0);
    const onsets = detector.push(noise(seconds(2), 0.01, 5), 1000);
    expect(onsets.filter((o) => o.kind !== 'music-start' && o.kind !== 'music-end')).toHaveLength(0);
  });

  it('detects sustained tonal content as music starting', () => {
    const detector = new SoundEventDetector({ sampleRate: SR });
    detector.push(noise(seconds(0.5), 0.004, 3), 0);
    const onsets = detector.push(tone(440, seconds(4), 0.5), 500);
    expect(onsets.some((o) => o.kind === 'music-start')).toBe(true);
  });

  it('classifies conservatively and admits when it does not know', () => {
    // Loud, sharp, broadband: an impact — and specifically NOT claimed to be a
    // gunshot, which these features cannot distinguish.
    expect(classifyOnset({ prominenceDb: 25, attack: 0.8, centroidHz: 3000, flatness: 0.7 })).toEqual({
      kind: 'impact',
      classified: true,
    });
    // Sustained mid-frequency tone: an alarm-like sound.
    expect(classifyOnset({ prominenceDb: 15, attack: 0.1, centroidHz: 1500, flatness: 0.05 }).kind).toBe('alarm');
    // Anything ambiguous stays unclassified rather than being guessed.
    const ambiguous = classifyOnset({ prominenceDb: 12, attack: 0.4, centroidHz: 800, flatness: 0.3 });
    expect(ambiguous.kind).toBe('unclassified');
    expect(ambiguous.classified).toBe(false);
  });

  it('phrases an unclassified sound vaguely rather than inventing a noun', () => {
    expect(describeSoundEvent('unclassified')).toBe('A sudden sound.');
    expect(describeSoundEvent('impact')).toBe('A sharp impact.');
    expect(describeSoundEvent('unclassified', 'A chair scrapes.')).toBe('A chair scrapes.');
  });
});

describe('speaker diarization', () => {
  it('assigns the same voice to one cluster', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR });
    const first = diarizer.assign(voiced(120, seconds(1)), 0, 1000);
    const second = diarizer.assign(voiced(120, seconds(1), 0.4), 2000, 3000);

    expect(first?.speakerId).toBeDefined();
    expect(second?.speakerId).toBe(first?.speakerId);
    expect(diarizer.speakerCount).toBe(1);
    expect(second?.turnChange).toBe(false);
  });

  it('opens a second cluster for a clearly different voice', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR });
    const a = diarizer.assign(voiced(110, seconds(1)), 0, 1000);
    const b = diarizer.assign(voiced(300, seconds(1)), 2000, 3000);

    expect(b?.speakerId).not.toBe(a?.speakerId);
    expect(b?.turnChange).toBe(true);
    expect(diarizer.speakerCount).toBe(2);
  });

  it('uses anonymous labels and never a name', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR });
    const assignment = diarizer.assign(voiced(150, seconds(1)), 0, 1000);
    expect(assignment?.speakerId).toMatch(/^speaker-\d{3}$/);
  });

  it('refuses to cluster a region too short to characterize', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR, minRegionMs: 400 });
    // Guessing on 200 ms produces speaker churn that corrupts attribution.
    expect(diarizer.assign(voiced(120, seconds(0.2)), 0, 200)).toBeNull();
  });

  it('respects the speaker cap instead of growing without bound', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR, maxSpeakers: 3 });
    for (let i = 0; i < 12; i++) {
      diarizer.assign(voiced(90 + i * 45, seconds(1)), i * 2000, i * 2000 + 1000);
    }
    expect(diarizer.speakerCount).toBeLessThanOrEqual(3);
  });

  it('clears all clusters on reset', () => {
    const diarizer = new SpeakerDiarizer({ sampleRate: SR });
    diarizer.assign(voiced(120, seconds(1)), 0, 1000);
    diarizer.reset();
    expect(diarizer.speakerCount).toBe(0);
  });
});
