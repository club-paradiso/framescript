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

import { LIMITS } from './config.js';
import { describeError, errorDetail, FrameScriptError } from '../../src/utils/errors.js';
import { isAbort } from '../../src/ai/retry.js';

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
 * Provider failures are dependencies failing behind FrameScript, so deterministic
 * upstream request/auth/response failures are represented as 502 rather than a
 * misleading FrameScript 500. The browser still uses the typed body code to
 * decide whether retrying can help.
 */
export function errorResponse(error: unknown): Response {
  if (isAbort(error)) return json({ code: 'ANALYSIS_ABORTED', message: 'Request cancelled.' }, 499);

  const { code, message } = describeError(error);
  const rateLimited = code === 'ASR_RATE_LIMITED' || code === 'VISION_RATE_LIMITED';
  const notConfigured = code === 'ASR_NOT_CONFIGURED' || code === 'VISION_NOT_CONFIGURED';
  const modelUnavailable =
    code === 'ASR_MODEL_UNAVAILABLE' || code === 'VISION_MODEL_UNAVAILABLE';
  const dependencyFailure =
    code === 'ASR_BAD_REQUEST' ||
    code === 'ASR_AUTH_FAILED' ||
    code === 'ASR_PROVIDER_FAILED' ||
    code === 'ASR_RESPONSE_INVALID' ||
    code === 'VISION_BAD_REQUEST' ||
    code === 'VISION_AUTH_FAILED' ||
    code === 'VISION_PROVIDER_FAILED' ||
    code === 'VISION_RESPONSE_INVALID' ||
    code === 'AI_RESPONSE_INVALID';

  const status = rateLimited
    ? 429
    : notConfigured || modelUnavailable
      ? 503
      : dependencyFailure || (FrameScriptError.is(error) && error.recoverable)
        ? 502
        : 500;

  // Logged server-side only. Provider adapters deliberately include only safe
  // status/type/code/model/size metadata, never provider bodies, auth, or media.
  console.error('[framescript-api]', code, errorDetail(error));
  return json({ code, message }, status);
}

/** Rejects a body larger than the limit before it is buffered. */
export function declaredTooLarge(request: Request, limit = LIMITS.maxRequestBytes): boolean {
  const declared = Number(request.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) && declared > limit;
}
