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

import { isError, readAsrConfig, LIMITS } from './_lib/config';
import {
  badRequest,
  declaredTooLarge,
  errorResponse,
  json,
  methodNotAllowed,
  tooLarge,
} from './_lib/http';
import { transcribeWav } from '../src/ai/providers/openaiCompatible';
import { FrameScriptError } from '../src/utils/errors';

export const config = { maxDuration: 60 };

/** BCP-47-ish, and short. Rejects anything that is not a plain language tag. */
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (declaredTooLarge(request))
    return tooLarge('Audio window is larger than this endpoint accepts.');

  const asr = readAsrConfig();
  if (isError(asr)) {
    // A precise, non-secret configuration status. The client turns this into
    // "Speech was detected, but transcription is not configured."
    return json({ code: 'ASR_NOT_CONFIGURED', message: asr.error }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest('Expected multipart/form-data with an "audio" part.');
  }

  const audio = form.get('audio');
  if (!(audio instanceof Blob)) return badRequest('Missing "audio" part.');
  if (audio.size === 0) return badRequest('Empty audio window.');
  if (audio.size > LIMITS.maxAudioBytes) return tooLarge('Audio window exceeds the size limit.');

  const startMs = numberField(form, 'startMs');
  const endMs = numberField(form, 'endMs');
  if (startMs === null || endMs === null || endMs <= startMs) {
    return badRequest('Invalid window timestamps.');
  }
  if (endMs - startMs > LIMITS.maxWindowMs) {
    return badRequest(`Window longer than ${LIMITS.maxWindowMs} ms; split it before sending.`);
  }

  const rawLanguage = form.get('language');
  const languageHint =
    typeof rawLanguage === 'string' && LANGUAGE.test(rawLanguage) ? rawLanguage : undefined;

  const wav = new Uint8Array(await audio.arrayBuffer());
  if (!looksLikeWav(wav)) return badRequest('Audio part is not a WAV window.');

  try {
    const result = await transcribeWav({
      wav,
      endpoint: asr.endpoint,
      apiKey: asr.apiKey,
      model: asr.model,
      ...(languageHint ? { languageHint } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    // No speech in a window the VAD thought was speech is a normal outcome and
    // must produce no dialogue rather than an empty line.
    if (!result) return json({ start: startMs, end: endMs, text: '', segments: [] });

    return json({
      start: startMs,
      end: endMs,
      text: result.text,
      ...(result.language ? { language: result.language } : {}),
      segments: result.segments ?? [],
      provider: asr.provider,
      model: asr.model,
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
