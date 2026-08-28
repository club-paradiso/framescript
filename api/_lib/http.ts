/**
 * Shared request/response helpers for the FrameScript API routes.
 *
 * Three rules the routes rely on and this file enforces:
 *
 *   1. **Nothing is cached.** Every response carries `no-store`; these carry
 *      user media and transcripts, and neither belongs in a CDN or a service
 *      worker.
 *   2. **Errors never echo the provider.** A provider's error body can quote
 *      the request, and the request is audio or frames. Responses carry a
 *      FrameScript error code and a fixed message, nothing more.
 *   3. **Every request is bounded** before anything is read into memory.
 */

import { LIMITS } from './config';
import { describeError, errorDetail, FrameScriptError } from '../../src/utils/errors';
import { isAbort } from '../../src/ai/retry';

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allowed: string): Response {
  return json({ code: 'MESSAGE_INVALID', message: 'Method not allowed.' }, 405, { allow: allowed });
}

export function tooLarge(detail: string): Response {
  return json({ code: 'MESSAGE_INVALID', message: detail }, 413);
}

export function badRequest(detail: string): Response {
  return json({ code: 'MESSAGE_INVALID', message: detail }, 400);
}

/**
 * Turns anything thrown inside a route into a safe response.
 *
 * The status is chosen from the code so the browser's retry policy — which only
 * retries 429 and 5xx — lines up with what the failure actually was.
 */
export function errorResponse(error: unknown): Response {
  if (isAbort(error)) return json({ code: 'ANALYSIS_ABORTED', message: 'Request cancelled.' }, 499);

  const { code, message } = describeError(error);
  const status =
    code === 'ASR_RATE_LIMITED'
      ? 429
      : code === 'ASR_NOT_CONFIGURED' || code === 'VISION_NOT_CONFIGURED'
        ? 503
        : code === 'AI_RESPONSE_INVALID'
          ? 502
          : FrameScriptError.is(error) && error.recoverable
            ? 502
            : 500;

  // Logged server-side only. `errorDetail` never includes a key: the providers
  // construct their detail strings from the status code alone.
  console.error('[framescript-api]', code, errorDetail(error));
  return json({ code, message }, status);
}

/** Rejects a body larger than the limit before it is buffered. */
export function declaredTooLarge(request: Request, limit = LIMITS.maxRequestBytes): boolean {
  const declared = Number(request.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) && declared > limit;
}
