/**
 * Studio's client for its own analysis endpoints.
 *
 * Every request here is same-origin. Studio holds no provider key, no endpoint
 * URL and no vendor identity — it posts to `/api/*` on the origin it was served
 * from, and the deployment's server-side configuration decides the rest. That
 * is what lets the production CSP keep `connect-src 'self'`.
 *
 * What is sent is deliberately small and deliberately specific:
 *
 *   - `/api/transcribe` receives one WAV window of *detected speech*, 16 kHz
 *     mono, at most 30 seconds. Never the file, never silence, never music.
 *   - `/api/analyze-frame` receives a handful of downscaled JPEG keyframes for
 *     one window the local scanner already judged significant.
 *
 * Retries are bounded and only ever applied to genuinely transient failures.
 * A malformed request, rejected credential, unavailable model or invalid
 * provider response is reported once because repeating it cannot help.
 */

import {
  FrameScriptError,
  classifyHttpFailure,
  isAbort,
  validateVisionAnalysis,
  withRetry,
  type AsrResult,
  type FrameScriptErrorCode,
  type VisionWindowAnalysis,
} from '@/core';

export interface CapabilityState {
  configured: boolean;
  provider?: string;
  model?: string;
  reason?: string;
}

export interface Capabilities {
  transcription: CapabilityState;
  vision: CapabilityState;
  limits: {
    maxAudioBytes: number;
    maxWindowMs: number;
    maxFramesPerRequest: number;
    maxFrameBytes: number;
  };
  /** False when `/api` is not deployed at all, e.g. a static-only preview. */
  endpointReachable: boolean;
}

export const UNREACHABLE_CAPABILITIES: Capabilities = {
  transcription: { configured: false, reason: 'The analysis endpoint is not available.' },
  vision: { configured: false, reason: 'The analysis endpoint is not available.' },
  limits: {
    maxAudioBytes: 4 * 1024 * 1024,
    maxWindowMs: 30_000,
    maxFramesPerRequest: 8,
    maxFrameBytes: 512 * 1024,
  },
  endpointReachable: false,
};

interface ApiErrorBody {
  code?: string;
  message?: string;
}

const KNOWN_CODES = new Set<string>([
  'ASR_NOT_CONFIGURED',
  'ASR_BAD_REQUEST',
  'ASR_AUTH_FAILED',
  'ASR_MODEL_UNAVAILABLE',
  'ASR_PROVIDER_FAILED',
  'ASR_RATE_LIMITED',
  'ASR_RESPONSE_INVALID',
  'VISION_NOT_CONFIGURED',
  'VISION_BAD_REQUEST',
  'VISION_AUTH_FAILED',
  'VISION_MODEL_UNAVAILABLE',
  'VISION_PROVIDER_FAILED',
  'VISION_RATE_LIMITED',
  'VISION_RESPONSE_INVALID',
  'AI_RESPONSE_INVALID',
  'MESSAGE_INVALID',
  'ANALYSIS_ABORTED',
]);

const NON_RETRYABLE_CODES = new Set<FrameScriptErrorCode>([
  'ASR_NOT_CONFIGURED',
  'ASR_BAD_REQUEST',
  'ASR_AUTH_FAILED',
  'ASR_MODEL_UNAVAILABLE',
  'ASR_RESPONSE_INVALID',
  'VISION_NOT_CONFIGURED',
  'VISION_BAD_REQUEST',
  'VISION_AUTH_FAILED',
  'VISION_MODEL_UNAVAILABLE',
  'VISION_RESPONSE_INVALID',
  'AI_RESPONSE_INVALID',
  'MESSAGE_INVALID',
]);

/**
 * A run shares one AbortSignal across its bounded workers. WeakMaps make that
 * signal a natural circuit-breaker key without introducing global run ids or
 * keeping completed analyses alive. At most the requests that were already in
 * flight when a deterministic failure arrived can still reach the server.
 */
const asrRunCircuits = new WeakMap<AbortSignal, FrameScriptError>();
const visionRunCircuits = new WeakMap<AbortSignal, FrameScriptError>();

/**
 * Turns a failed response into a typed error.
 *
 * The server's own code is trusted when it is one FrameScript defines;
 * otherwise the status alone decides, so a proxy or a CDN returning HTML still
 * produces a sensible error rather than a parse failure.
 */
async function toError(response: Response, kind: 'asr' | 'vision'): Promise<FrameScriptError> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = {};
  }
  const classified = classifyHttpFailure(response.status, kind);
  const code: FrameScriptErrorCode =
    body.code && KNOWN_CODES.has(body.code) ? (body.code as FrameScriptErrorCode) : classified.code;
  const recoverable = NON_RETRYABLE_CODES.has(code)
    ? false
    : code === 'ASR_RATE_LIMITED' || code === 'VISION_RATE_LIMITED'
      ? true
      : classified.retryable;
  return new FrameScriptError({
    code,
    detail: `${response.status} ${body.message ?? response.statusText}`.slice(0, 200),
    recoverable,
  });
}

function existingCircuit(
  signal: AbortSignal | undefined,
  circuits: WeakMap<AbortSignal, FrameScriptError>,
): FrameScriptError | undefined {
  return signal ? circuits.get(signal) : undefined;
}

function rememberDeterministicFailure(
  signal: AbortSignal | undefined,
  circuits: WeakMap<AbortSignal, FrameScriptError>,
  error: unknown,
): void {
  if (signal && FrameScriptError.is(error) && !error.recoverable && !isAbort(error)) {
    circuits.set(signal, error);
  }
}

export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  try {
    const response = await fetch('/api/capabilities', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return UNREACHABLE_CAPABILITIES;
    const body = (await response.json()) as Omit<Capabilities, 'endpointReachable'>;
    if (!body || typeof body !== 'object' || !body.transcription) return UNREACHABLE_CAPABILITIES;
    return {
      transcription: body.transcription,
      vision: body.vision ?? { configured: false },
      limits: body.limits ?? UNREACHABLE_CAPABILITIES.limits,
      endpointReachable: true,
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    // A static deployment with no functions is a legitimate configuration, not
    // a failure. Studio reports "not configured" and stays local-only.
    return UNREACHABLE_CAPABILITIES;
  }
}

export interface TranscribeWindowRequest {
  wav: Uint8Array;
  start: number;
  end: number;
  languageHint?: string;
  signal?: AbortSignal;
}

/** Posts one speech window. Resolves to null when the window held no words. */
export async function transcribeWindow(
  request: TranscribeWindowRequest,
): Promise<AsrResult | null> {
  const openCircuit = existingCircuit(request.signal, asrRunCircuits);
  if (openCircuit) throw openCircuit;

  try {
    return await withRetry(
      async () => {
        const form = new FormData();
        const buffer = new ArrayBuffer(request.wav.byteLength);
        new Uint8Array(buffer).set(request.wav);
        form.append('audio', new Blob([buffer], { type: 'audio/wav' }), 'window.wav');
        form.append('startMs', String(Math.round(request.start)));
        form.append('endMs', String(Math.round(request.end)));
        if (request.languageHint) form.append('language', request.languageHint);

        const response = await fetch('/api/transcribe', {
          method: 'POST',
          body: form,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!response.ok) throw await toError(response, 'asr');

        const body = (await response.json()) as {
          text?: unknown;
          language?: unknown;
          segments?: unknown;
        };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const segments = Array.isArray(body.segments)
          ? body.segments
              .map((raw) => raw as { startMs?: unknown; endMs?: unknown; text?: unknown })
              .filter(
                (raw) =>
                  typeof raw.text === 'string' &&
                  raw.text.trim().length > 0 &&
                  Number.isFinite(Number(raw.startMs)) &&
                  Number.isFinite(Number(raw.endMs)),
              )
              .map((raw) => ({
                startMs: Number(raw.startMs),
                endMs: Number(raw.endMs),
                text: (raw.text as string).trim(),
              }))
          : [];
        if (!text && segments.length === 0) return null;
        return {
          text: text || segments.map((segment) => segment.text).join(' '),
          ...(typeof body.language === 'string' && body.language ? { language: body.language } : {}),
          ...(segments.length > 0 ? { segments } : {}),
        };
      },
      { attempts: 3, ...(request.signal ? { signal: request.signal } : {}) },
    );
  } catch (error) {
    rememberDeterministicFailure(request.signal, asrRunCircuits, error);
    throw error;
  }
}

export interface AnalyzeFramesRequest {
  start: number;
  end: number;
  frames: { timestamp: number; base64: string; mimeType: string; width: number; height: number }[];
  dialogue: { start: number; speakerId?: string; text: string }[];
  soundEvents: { start: number; kind: string }[];
  requestOcr?: boolean;
  signal?: AbortSignal;
}

/** Sends one window of selected keyframes for semantic observation. */
export async function analyzeFrames(
  request: AnalyzeFramesRequest,
): Promise<VisionWindowAnalysis | null> {
  const openCircuit = existingCircuit(request.signal, visionRunCircuits);
  if (openCircuit) throw openCircuit;

  try {
    return await withRetry(
      async () => {
        const response = await fetch('/api/analyze-frame', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            start: Math.round(request.start),
            end: Math.round(request.end),
            frames: request.frames.map((frame) => ({
              timestamp: Math.round(frame.timestamp),
              data: frame.base64,
              mimeType: frame.mimeType,
              width: frame.width,
              height: frame.height,
            })),
            dialogue: request.dialogue,
            soundEvents: request.soundEvents,
            ...(request.requestOcr ? { requestOcr: true } : {}),
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!response.ok) throw await toError(response, 'vision');

        const body = (await response.json()) as { analysis?: unknown };
        if (!body.analysis) return null;
        // Validated a second time in the browser. The server already validated,
        // but the page must not render anything it has not checked itself.
        const analysis = validateVisionAnalysis(body.analysis);
        if (!analysis) {
          throw new FrameScriptError({
            code: 'VISION_RESPONSE_INVALID',
            detail: 'vision response failed client-side validation',
          });
        }
        return analysis;
      },
      { attempts: 2, ...(request.signal ? { signal: request.signal } : {}) },
    );
  } catch (error) {
    rememberDeterministicFailure(request.signal, visionRunCircuits, error);
    throw error;
  }
}

/**
 * Runs `worker` over `items` with a hard concurrency cap.
 *
 * Bounded on purpose: an unbounded map over 400 speech windows would open 400
 * sockets, exhaust the provider's rate limit in one second, and hold 400 WAV
 * buffers in memory at once.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
