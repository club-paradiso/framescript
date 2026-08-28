/**
 * OpenAI-compatible speech-to-text (BYOK).
 *
 * Targets the widely-implemented `/audio/transcriptions` endpoint, so it works
 * against OpenAI, a self-hosted Whisper server, or any compatible gateway. The
 * key and base URL are supplied by whoever constructs this; nothing is
 * hardcoded to a vendor.
 *
 * Only speech regions are ever sent — VAD gates this — and only as short WAV
 * windows. Non-speech audio and music are never uploaded.
 *
 * Two entry points, one implementation:
 *
 *   - `transcribeWav` takes an already-encoded WAV. Web Studio resamples and
 *     encodes in the page and posts the result to its own `/api/transcribe`,
 *     which forwards it from the server where the key lives.
 *   - `OpenAiCompatibleAsrProvider` takes PCM and does the resampling itself.
 *     The extension's offscreen document uses it directly with the user's key.
 *
 * Both paths transmit exactly the same bytes to the provider.
 */

import type {
  AsrRequest,
  AsrResult,
  AsrSegment,
  ProviderAvailability,
  SpeechRecognitionProvider,
} from '../types.js';
import { encodeWav, resampleLinear } from '../../audio/dsp.js';
import { FrameScriptError } from '../../utils/errors.js';
import { providerError } from '../retry.js';

export interface OpenAiCompatibleAsrConfig {
  apiKey: string;
  /** Full endpoint URL, e.g. https://api.openai.com/v1/audio/transcriptions */
  endpoint: string;
  model: string;
  /** Providers overwhelmingly expect 16 kHz mono. */
  targetSampleRate?: number;
  /** Refuse to send windows longer than this. */
  maxWindowMs?: number;
  /**
   * `verbose_json` asks for segment timings. Not every compatible server
   * implements it, so a caller can drop back to plain `json`.
   */
  responseFormat?: 'json' | 'verbose_json';
}

export const DEFAULT_ASR_SAMPLE_RATE = 16_000;
export const DEFAULT_ASR_MAX_WINDOW_MS = 30_000;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  en: 'en',
  eng: 'en',
  english: 'en',
  ko: 'ko',
  kor: 'ko',
  korean: 'ko',
  es: 'es',
  spa: 'es',
  spanish: 'es',
  espanol: 'es',
  español: 'es',
};

interface TranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start?: number; end?: number; text?: string }[];
  error?: { message?: string };
}

export interface TranscribeWavRequest {
  wav: Uint8Array;
  endpoint: string;
  apiKey: string;
  model: string;
  languageHint?: string;
  responseFormat?: 'json' | 'verbose_json';
  signal?: AbortSignal;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Canonicalizes common provider language labels into stable BCP-47 primary
 * language tags. Some transcription APIs return `english`/`korean`/`spanish`
 * while others return `en`/`ko`/`es`; carrying those strings verbatim would
 * split one language into several screenplay variants.
 *
 * An explicit language hint is the fallback when the provider omits language
 * metadata. This is particularly useful for compatible endpoints that return
 * only `{ text }` even though they accepted the hint correctly.
 */
export function normalizeAsrLanguage(
  providerLanguage?: string,
  languageHint?: string,
): string | undefined {
  for (const candidate of [providerLanguage, languageHint]) {
    if (!candidate) continue;
    const normalized = candidate.trim().toLocaleLowerCase().replace(/_/g, '-');
    if (!normalized) continue;
    const aliased = LANGUAGE_ALIASES[normalized];
    if (aliased) return aliased;

    const primary = normalized.split('-')[0];
    if (!primary || !/^[a-z]{2,3}$/.test(primary)) continue;
    return LANGUAGE_ALIASES[primary] ?? primary;
  }
  return undefined;
}

/**
 * Posts one WAV window to an OpenAI-compatible transcription endpoint.
 *
 * Throws a typed `FrameScriptError` for any non-2xx status, carrying whether a
 * retry could plausibly help. The provider's response body is deliberately not
 * echoed into the error: it can quote the request, and the request is audio.
 */
export async function transcribeWav(request: TranscribeWavRequest): Promise<AsrResult | null> {
  const form = new FormData();
  form.append('file', wavBlob(request.wav), 'window.wav');
  form.append('model', request.model);
  form.append('response_format', request.responseFormat ?? 'verbose_json');
  if (request.languageHint) form.append('language', request.languageHint);

  const doFetch = request.fetchImpl ?? fetch;
  const response = await doFetch(request.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${request.apiKey}` },
    body: form,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (!response.ok) {
    throw providerError(response.status, 'asr', `transcription endpoint returned ${response.status}`);
  }

  let json: TranscriptionResponse;
  try {
    json = (await response.json()) as TranscriptionResponse;
  } catch {
    throw new FrameScriptError({
      code: 'AI_RESPONSE_INVALID',
      detail: 'transcription response was not JSON',
    });
  }
  if (json.error) {
    throw new FrameScriptError({ code: 'ASR_PROVIDER_FAILED', detail: 'provider reported an error' });
  }

  const text = typeof json.text === 'string' ? json.text.trim() : '';
  const segments = normalizeSegments(json.segments);
  if (!text && segments.length === 0) return null;

  const language = normalizeAsrLanguage(json.language, request.languageHint);
  return {
    text: text || segments.map((segment) => segment.text).join(' ').trim(),
    ...(language ? { language } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };
}

function wavBlob(wav: Uint8Array): Blob {
  const buffer = new ArrayBuffer(wav.byteLength);
  new Uint8Array(buffer).set(wav);
  return new Blob([buffer], { type: 'audio/wav' });
}

function normalizeSegments(raw: TranscriptionResponse['segments']): AsrSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrSegment[] = [];
  for (const segment of raw.slice(0, 200)) {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text) continue;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
    out.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text });
  }
  return out;
}

export function encodeAsrWindow(
  samples: Float32Array,
  sampleRate: number,
  targetSampleRate = DEFAULT_ASR_SAMPLE_RATE,
): Uint8Array | null {
  const resampled = resampleLinear(samples, sampleRate, targetSampleRate);
  if (resampled.length < targetSampleRate * 0.1) return null;
  return encodeWav(resampled, targetSampleRate);
}

export class OpenAiCompatibleAsrProvider implements SpeechRecognitionProvider {
  #config: OpenAiCompatibleAsrConfig;

  readonly info = {
    id: 'openai-compatible-asr',
    label: 'Speech-to-text endpoint (your API key)',
    kind: 'remote' as const,
    dataLeavingDevice:
      'Short audio windows containing detected speech, downsampled to 16 kHz mono. Silence, music and non-speech audio are not sent.',
  };

  constructor(config: OpenAiCompatibleAsrConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.#config.apiKey) return { available: false, reason: 'No API key configured.' };
    if (!this.#config.endpoint) return { available: false, reason: 'No endpoint configured.' };
    if (!this.#config.model) return { available: false, reason: 'No model configured.' };
    return { available: true };
  }

  async transcribe(request: AsrRequest): Promise<AsrResult | null> {
    const durationMs = request.end - request.start;
    const maxWindow = this.#config.maxWindowMs ?? DEFAULT_ASR_MAX_WINDOW_MS;
    if (durationMs <= 0) return null;
    if (durationMs > maxWindow) {
      throw new FrameScriptError({
        code: 'ASR_PROVIDER_FAILED',
        detail: `speech window ${durationMs}ms exceeds ${maxWindow}ms limit`,
      });
    }

    const wav = encodeAsrWindow(
      request.samples,
      request.sampleRate,
      this.#config.targetSampleRate ?? DEFAULT_ASR_SAMPLE_RATE,
    );
    if (!wav) return null;

    return transcribeWav({
      wav,
      endpoint: this.#config.endpoint,
      apiKey: this.#config.apiKey,
      model: this.#config.model,
      ...(this.#config.responseFormat ? { responseFormat: this.#config.responseFormat } : {}),
      ...(request.languageHint ? { languageHint: request.languageHint } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }
}
