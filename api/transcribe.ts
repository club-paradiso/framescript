/**
 * POST /api/transcribe
 *
 * The one place a FrameScript deployment holds a speech-to-text credential.
 *
 * What arrives: a single WAV window of *detected speech*, already downsampled
 * to 16 kHz mono in the browser, plus the media timestamps it came from. What
 * does not arrive: the file, the video track, silence, music, or any audio the
 * VAD did not mark as speech. The browser decides what is speech; this route
 * only forwards it.
 *
 * What goes back: the transcript for that window, and segment timings when the
 * provider reports them. The evidence conversion happens in the client, using
 * the same `transcriptToEvidence` the extension uses.
 *
 * Nothing is stored. The window exists for the duration of one request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isError, readAsrConfig, LIMITS } from './_lib/config.js';
import {
  badRequest,
  declaredTooLarge,
  errorResponse,
  json,
  methodNotAllowed,
  tooLarge,
} from './_lib/http.js';
import { transcribeViaGateway } from './_lib/gatewayAsr.js';
import { toWebRequest, writeWebResponse } from './_lib/nodeAdapter.js';
import { transcribeWav } from '../src/ai/providers/openaiCompatible.js';
import { isAbort } from '../src/ai/retry.js';
import { FrameScriptError } from '../src/utils/errors.js';

export const config = { maxDuration: 60 };

/** BCP-47-ish, and short. Rejects anything that is not a plain language tag. */
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

export async function POST(request: Request): Promise<Response> {
  if (declaredTooLarge(request))
    return tooLarge('Audio window is larger than this endpoint accepts.');

  const asr = readAsrConfig();
  if (isError(asr)) {
    return json({ code: 'ASR_NOT_CONFIGURED', message: asr.error }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest('Expected multipart/form-data with an "audio" part.', 'ASR_BAD_REQUEST');
  }

  const audio = form.get('audio');
  if (!(audio instanceof Blob)) return badRequest('Missing "audio" part.', 'ASR_BAD_REQUEST');
  if (audio.size === 0) return badRequest('Empty audio window.', 'ASR_BAD_REQUEST');
  if (audio.size > LIMITS.maxAudioBytes) return tooLarge('Audio window exceeds the size limit.');

  const startMs = numberField(form, 'startMs');
  const endMs = numberField(form, 'endMs');
  if (startMs === null || endMs === null || endMs <= startMs) {
    return badRequest('Invalid window timestamps.', 'ASR_BAD_REQUEST');
  }
  if (endMs - startMs > LIMITS.maxWindowMs) {
    return badRequest(
      `Window longer than ${LIMITS.maxWindowMs} ms; split it before sending.`,
      'ASR_BAD_REQUEST',
    );
  }

  const rawLanguage = form.get('language');
  const languageHint =
    typeof rawLanguage === 'string' && LANGUAGE.test(rawLanguage) ? rawLanguage : undefined;

  const wav = new Uint8Array(await audio.arrayBuffer());
  if (!looksLikeWav(wav)) return badRequest('Audio part is not a WAV window.', 'ASR_BAD_REQUEST');

  const GATEWAY_ASR_FALLBACK_MODEL = 'openai/gpt-4o-mini-transcribe';

  try {
    let result;
    let effectiveModel = asr.model;

    if (asr.provider === 'vercel-ai-gateway') {
      try {
        result = await transcribeViaGateway({
          wav,
          endpoint: asr.endpoint,
          token: asr.apiKey,
          authMethod: asr.gatewayAuthMethod ?? 'oidc',
          model: asr.model,
          ...(languageHint ? { languageHint } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (primaryError) {
        if (isAbort(primaryError) || request.signal?.aborted) throw primaryError;

        // Fallback to cheaper gpt-4o-mini-transcribe is permitted ONLY for model-specific
        // outages (404 model_not_found, or 5xx provider failure on the primary model)
        // on Vercel AI Gateway where attempting the cheaper backup is intentional.
        // It strictly refuses fallback for:
        // - account verification gates, insufficient funds, payment required
        // - authentication failure (401/403)
        // - bad request / unsupported parameters (400)
        // - rate-limit conditions (429) to avoid multiplying requests under load
        // - cancellations / aborts
        // - when disabled by the operator (FRAMESCRIPT_DISABLE_ASR_FALLBACK=1)
        const isAccountGate =
          FrameScriptError.is(primaryError) &&
          (primaryError.reason === 'payment_required' ||
            primaryError.reason === 'insufficient_funds' ||
            primaryError.reason === 'customer_verification_required');

        const isModelOrOutageFailure =
          FrameScriptError.is(primaryError) &&
          (primaryError.code === 'ASR_MODEL_UNAVAILABLE' ||
            primaryError.code === 'ASR_PROVIDER_FAILED');

        const fallbackDisabled = process.env.FRAMESCRIPT_DISABLE_ASR_FALLBACK === '1';

        const canFallback =
          !fallbackDisabled &&
          !isAccountGate &&
          asr.model !== GATEWAY_ASR_FALLBACK_MODEL &&
          isModelOrOutageFailure;

        if (canFallback) {
          console.warn(
            `[framescript-api] Primary Gateway ASR model ${asr.model} failed, attempting cheaper verified fallback ${GATEWAY_ASR_FALLBACK_MODEL}`,
          );
          result = await transcribeViaGateway({
            wav,
            endpoint: asr.endpoint,
            token: asr.apiKey,
            authMethod: asr.gatewayAuthMethod ?? 'oidc',
            model: GATEWAY_ASR_FALLBACK_MODEL,
            ...(languageHint ? { languageHint } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          });
          effectiveModel = GATEWAY_ASR_FALLBACK_MODEL;
        } else {
          throw primaryError;
        }
      }
    } else {
      result = await transcribeWav({
        wav,
        endpoint: asr.endpoint,
        apiKey: asr.apiKey,
        model: asr.model,
        ...(languageHint ? { languageHint } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    }

    if (!result) return json({ start: startMs, end: endMs, text: '', segments: [] });

    return json({
      start: startMs,
      end: endMs,
      text: result.text,
      ...(result.language ? { language: result.language } : {}),
      segments: result.segments ?? [],
      provider: asr.provider,
      model: effectiveModel,
    });
  } catch (error) {
    if (FrameScriptError.is(error) && error.code === 'AI_RESPONSE_INVALID') {
      return errorResponse(
        new FrameScriptError({
          code: 'ASR_PROVIDER_FAILED',
          detail: error.detail ?? 'invalid response',
        }),
      );
    }
    return errorResponse(error);
  }
}

/** Direct tests use Web Request; Vercel uses legacy Node req/res. */
export default function handler(request: Request): Promise<Response>;
export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
export default async function handler(
  request: Request | IncomingMessage,
  response?: ServerResponse,
): Promise<Response | void> {
  if (request instanceof Request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return POST(request);
  }
  if (!response) throw new TypeError('Vercel Node response is required.');

  if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
    await writeWebResponse(response, methodNotAllowed('POST'));
    return;
  }

  const webRequest = await toWebRequest(request);
  const result = await POST(webRequest);
  await writeWebResponse(response, result);
}

function numberField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== 'string') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function looksLikeWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
