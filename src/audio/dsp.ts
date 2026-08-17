/**
 * Signal-processing primitives.
 *
 * Small, dependency-free and deterministic so the audio engine can be tested
 * against synthetic tones and noise rather than against a real soundtrack.
 * Everything here runs locally; no audio ever leaves this module.
 */

/** Root-mean-square amplitude of a frame. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/** Amplitude to dBFS. Floors at -100 dB so silence does not produce -Infinity. */
export function amplitudeToDb(amplitude: number): number {
  return amplitude <= 1e-5 ? -100 : Math.max(-100, 20 * Math.log10(amplitude));
}

/**
 * Zero-crossing rate.
 *
 * Voiced speech has a low ZCR (periodic, low-frequency energy); fricatives and
 * broadband noise have a high one. Used alongside energy so that a burst of
 * hiss is not mistaken for someone talking.
 */
export function zeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) crossings++;
  }
  return crossings / (samples.length - 1);
}

/** In-place Hann window; reduces spectral leakage before the FFT. */
export function applyHannWindow(samples: Float32Array): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = samples[i]! * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return out;
}

/**
 * Iterative in-place radix-2 FFT.
 *
 * `real` and `imag` must have power-of-two length. Chosen over a library
 * dependency because this is the only transform FrameScript needs and it must
 * run inside a worker with no network access.
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n !== imag.length || (n & (n - 1)) !== 0) {
    throw new Error('fft requires power-of-two, equal-length arrays');
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k++) {
        const uReal = real[i + k]!;
        const uImag = imag[i + k]!;
        const vReal = real[i + k + len / 2]! * curReal - imag[i + k + len / 2]! * curImag;
        const vImag = real[i + k + len / 2]! * curImag + imag[i + k + len / 2]! * curReal;
        real[i + k] = uReal + vReal;
        imag[i + k] = uImag + vImag;
        real[i + k + len / 2] = uReal - vReal;
        imag[i + k + len / 2] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** Magnitude spectrum (first n/2 bins) of a real-valued frame. */
export function magnitudeSpectrum(samples: Float32Array): Float32Array {
  const n = nextPowerOfTwo(samples.length);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  const windowed = applyHannWindow(samples);
  real.set(windowed);
  fft(real, imag);

  const bins = n >> 1;
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    out[i] = Math.hypot(real[i]!, imag[i]!) / bins;
  }
  return out;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
export const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

/**
 * Triangular mel filterbank energies.
 *
 * Mel spacing matches how human hearing resolves pitch, which makes these
 * features far better at separating two voices than raw FFT bins would be.
 */
export function melFilterbank(
  spectrum: Float32Array,
  sampleRate: number,
  bandCount = 20,
  minHz = 80,
  maxHz = 8000,
): Float32Array {
  const bins = spectrum.length;
  const nyquist = sampleRate / 2;
  const upper = Math.min(maxHz, nyquist);
  const melMin = hzToMel(minHz);
  const melMax = hzToMel(upper);

  const points = new Float32Array(bandCount + 2);
  for (let i = 0; i < points.length; i++) {
    const mel = melMin + ((melMax - melMin) * i) / (bandCount + 1);
    points[i] = (melToHz(mel) / nyquist) * bins;
  }

  const out = new Float32Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    const left = points[b]!;
    const centre = points[b + 1]!;
    const right = points[b + 2]!;
    let sum = 0;
    for (let k = Math.floor(left); k < Math.ceil(right) && k < bins; k++) {
      if (k < 0) continue;
      const weight = k < centre ? (k - left) / Math.max(1e-6, centre - left) : (right - k) / Math.max(1e-6, right - centre);
      if (weight > 0) sum += spectrum[k]! * weight;
    }
    out[b] = sum;
  }
  return out;
}

/** DCT-II, used to decorrelate log-mel energies into cepstral coefficients. */
export function dct(input: Float32Array, coefficients: number): Float32Array {
  const n = input.length;
  const out = new Float32Array(coefficients);
  for (let k = 0; k < coefficients; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i]! * Math.cos((Math.PI * k * (i + 0.5)) / n);
    }
    out[k] = sum;
  }
  return out;
}

/**
 * Compact cepstral feature vector for one frame.
 *
 * Used as a *voice fingerprint* for diarization — "is this the same voice as
 * before?" — and deliberately not for identifying who anyone is.
 */
export function computeMfcc(
  samples: Float32Array,
  sampleRate: number,
  coefficients = 13,
  bands = 20,
): Float32Array {
  const spectrum = magnitudeSpectrum(samples);
  const mel = melFilterbank(spectrum, sampleRate, bands);
  const logMel = new Float32Array(bands);
  for (let i = 0; i < bands; i++) logMel[i] = Math.log(Math.max(1e-10, mel[i]!));
  return dct(logMel, coefficients);
}

/**
 * Spectral flux: total positive change between consecutive spectra.
 * The standard onset cue — a door slam is a flux spike.
 */
export function spectralFlux(previous: Float32Array, current: Float32Array): number {
  const n = Math.min(previous.length, current.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const diff = current[i]! - previous[i]!;
    if (diff > 0) sum += diff;
  }
  return sum;
}

/** Spectral centroid in Hz — the "brightness" of a sound. */
export function spectralCentroid(spectrum: Float32Array, sampleRate: number): number {
  let weighted = 0;
  let total = 0;
  const binHz = sampleRate / 2 / spectrum.length;
  for (let i = 0; i < spectrum.length; i++) {
    weighted += spectrum[i]! * i * binHz;
    total += spectrum[i]!;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Spectral flatness (Wiener entropy) in [0,1].
 * Near 1 for noise (applause, breaking glass), near 0 for tonal sound (music,
 * a phone ring, a sustained vowel).
 */
export function spectralFlatness(spectrum: Float32Array): number {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (const v of spectrum) {
    const value = Math.max(1e-10, v);
    logSum += Math.log(value);
    sum += value;
    count++;
  }
  if (count === 0 || sum === 0) return 0;
  const geometric = Math.exp(logSum / count);
  const arithmetic = sum / count;
  return Math.min(1, geometric / arithmetic);
}

/** Cosine distance in [0,2]; 0 means identical direction. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Resamples by linear interpolation. Adequate for ASR-bound 16 kHz mono. */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** Encodes mono float PCM as a 16-bit WAV, for ASR providers that want a file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}
