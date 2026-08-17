/**
 * OpenAI-compatible speech-to-text provider (BYOK).
 *
 * Targets the widely-implemented `/audio/transcriptions` endpoint, so it works
 * against OpenAI, a self-hosted Whisper server, or any compatible gateway. The
 * user supplies the base URL and key; nothing is hardcoded to a vendor.
 *
 * Only speech regions are sent — VAD gates this — and only as short WAV
 * windows. Non-speech audio and music are never uploaded.
 */

import type {
  AsrRequest,
  AsrResult,
  ProviderAvailability,
  SpeechRecognitionProvider,
} from '../types';
import { encodeWav, resampleLinear } from '../../audio/dsp';
import { FrameScriptError } from '../../utils/errors';

export interface OpenAiCompatibleAsrConfig {
  apiKey: string;
  /** Full endpoint URL, e.g. https://api.openai.com/v1/audio/transcriptions */
  endpoint: string;
  model: string;
  /** Providers overwhelmingly expect 16 kHz mono. */
  targetSampleRate?: number;
  /** Refuse to send windows longer than this. */
  maxWindowMs?: number;
}

const DEFAULT_TARGET_RATE = 16_000;
const DEFAULT_MAX_WINDOW_MS = 30_000;

interface TranscriptionResponse {
  text?: string;
  language?: string;
  error?: { message?: string };
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
    const maxWindow = this.#config.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    if (durationMs <= 0) return null;
    if (durationMs > maxWindow) {
      // The caller is responsible for splitting; sending a 10-minute region
      // would be both expensive and useless for alignment.
      throw new FrameScriptError({
        code: 'AI_PROVIDER_FAILED',
        detail: `speech window ${durationMs}ms exceeds ${maxWindow}ms limit`,
      });
    }

    const targetRate = this.#config.targetSampleRate ?? DEFAULT_TARGET_RATE;
    const resampled = resampleLinear(request.samples, request.sampleRate, targetRate);
    if (resampled.length < targetRate * 0.1) return null;

    const wav = encodeWav(resampled, targetRate);
    const form = new FormData();
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'window.wav');
    form.append('model', this.#config.model);
    form.append('response_format', 'json');
    if (request.languageHint) form.append('language', request.languageHint);

    const response = await fetch(this.#config.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#config.apiKey}` },
      body: form,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      throw new FrameScriptError({
        code: 'AI_PROVIDER_FAILED',
        detail: `transcription endpoint returned ${response.status}`,
        recoverable: response.status === 429 || response.status >= 500,
      });
    }

    const json = (await response.json()) as TranscriptionResponse;
    if (json.error) {
      throw new FrameScriptError({ code: 'AI_PROVIDER_FAILED', detail: 'transcription error' });
    }
    const text = json.text?.trim();
    if (!text) return null;

    return {
      text,
      ...(json.language ? { language: json.language } : {}),
    };
  }
}
