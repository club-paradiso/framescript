import type { AsrResult, AsrSegment } from '../../src/ai/types.js';
import { normalizeAsrLanguage } from '../../src/ai/providers/openaiCompatible.js';
import { providerResponseError } from '../../src/ai/retry.js';
import { FrameScriptError } from '../../src/utils/errors.js';
import { toBase64 } from '../../src/utils/base64.js';
import type { GatewayAuthMethod } from './config.js';

interface GatewayTranscriptionResponse {
  text?: unknown;
  language?: unknown;
  segments?: unknown;
  durationInSeconds?: unknown;
  warnings?: unknown;
}

interface GatewaySegment {
  text?: unknown;
  startSecond?: unknown;
  endSecond?: unknown;
  start?: unknown;
  end?: unknown;
}

export interface GatewayTranscribeRequest {
  wav: Uint8Array;
  endpoint: string;
  token: string;
  authMethod: GatewayAuthMethod;
  model: string;
  languageHint?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Sends one already-bounded WAV speech window through Vercel AI Gateway.
 *
 * This mirrors the current `@ai-sdk/gateway` v4 transcription transport:
 * Gateway protocol/auth headers + model id + transcription specification
 * version, and a JSON body with base64 audio plus its media type. The protocol
 * and auth-method headers are part of the official provider envelope; omitting
 * them causes the Gateway to reject an otherwise valid transcription request as
 * `invalid_request_error` before the upstream model receives the audio.
 */
export async function transcribeViaGateway(
  request: GatewayTranscribeRequest,
): Promise<AsrResult | null> {
  const doFetch = request.fetchImpl ?? fetch;
  const response = await doFetch(request.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${request.token}`,
      'content-type': 'application/json',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': request.authMethod,
      'ai-transcription-model-specification-version': '4',
      'ai-model-id': request.model,
    },
    body: JSON.stringify({
      audio: toBase64(request.wav),
      mediaType: 'audio/wav',
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  if (!response.ok) {
    throw await providerResponseError(
      response,
      'asr',
      `gateway=vercel model=${request.model} protocol=0.0.1 authMethod=${request.authMethod} spec=4 mediaType=audio/wav wavBytes=${request.wav.byteLength}`,
    );
  }

  let body: GatewayTranscriptionResponse;
  try {
    body = (await response.json()) as GatewayTranscriptionResponse;
  } catch {
    throw new FrameScriptError({
      code: 'ASR_RESPONSE_INVALID',
      detail: `gateway=vercel model=${request.model} response=non-json`,
    });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const segments = normalizeGatewaySegments(body.segments);
  if (!text && segments.length === 0) return null;

  const providerLanguage = typeof body.language === 'string' ? body.language : undefined;
  const language = normalizeAsrLanguage(providerLanguage, request.languageHint);
  return {
    text: text || segments.map((segment) => segment.text).join(' ').trim(),
    ...(language ? { language } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };
}

function normalizeGatewaySegments(raw: unknown): AsrSegment[] {
  if (!Array.isArray(raw)) return [];
  const result: AsrSegment[] = [];
  for (const value of raw.slice(0, 200)) {
    if (!value || typeof value !== 'object') continue;
    const segment = value as GatewaySegment;
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!text) continue;

    const startSeconds = finite(segment.startSecond) ?? finite(segment.start);
    const endSeconds = finite(segment.endSecond) ?? finite(segment.end);
    if (
      startSeconds === null ||
      endSeconds === null ||
      startSeconds < 0 ||
      endSeconds < startSeconds
    ) {
      continue;
    }
    result.push({
      startMs: Math.round(startSeconds * 1000),
      endMs: Math.round(endSeconds * 1000),
      text,
    });
  }
  return result;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
