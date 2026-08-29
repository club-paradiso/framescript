/**
 * Provider failure classification and bounded retry.
 *
 * Retrying the wrong thing is worse than not retrying: a 401 will never
 * succeed, and hammering a 400 four times turns one clear error into four
 * confusing ones. So classification comes first and retry is derived from it,
 * rather than every call site deciding for itself.
 *
 * Retries are always bounded and always honour an abort signal. There is no
 * code path here that can loop indefinitely.
 */

import { FrameScriptError, type FrameScriptErrorCode } from '../utils/errors.js';

export type ProviderKindForErrors = 'asr' | 'vision';

export interface HttpFailure {
  code: FrameScriptErrorCode;
  retryable: boolean;
}

/** Safe, non-payload metadata parsed from a provider error response. */
export interface ProviderFailureHint {
  type?: string;
  code?: string;
  statusCode?: number;
}

function codeFor(kind: ProviderKindForErrors, suffix: string): FrameScriptErrorCode {
  return `${kind === 'asr' ? 'ASR' : 'VISION'}_${suffix}` as FrameScriptErrorCode;
}

/**
 * Maps an HTTP status from a provider onto a FrameScript error code.
 *
 * A configured credential that is rejected by an upstream service is not the
 * same thing as missing configuration. `*_NOT_CONFIGURED` is therefore never
 * produced here; only the server-side config readers may emit it.
 *
 * Vercel AI Gateway uses 403 + `no_providers_available` when a team allowlist
 * blocks the requested model/provider. It also uses 403 +
 * `customer_verification_required` when the deployment's Vercel team must
 * complete account verification before paid inference is permitted. Neither
 * condition is fixed by retrying the same request or rotating model slugs, so
 * both are represented as deployment-level model unavailability rather than a
 * bad API credential.
 */
export function classifyHttpFailure(
  status: number,
  kind: ProviderKindForErrors,
  hint: ProviderFailureHint = {},
): HttpFailure {
  const failed = codeFor(kind, 'PROVIDER_FAILED');
  const normalizedType = hint.type?.trim().toLowerCase() ?? '';
  const normalizedCode = hint.code?.trim().toLowerCase() ?? '';
  const verificationRequired =
    normalizedType === 'customer_verification_required' ||
    normalizedCode === 'customer_verification_required';
  const modelUnavailable =
    verificationRequired ||
    normalizedType === 'no_providers_available' ||
    normalizedType.includes('model_not_found') ||
    normalizedCode.includes('model_not_found') ||
    normalizedCode.includes('model_unavailable');

  if (status === 429) return { code: codeFor(kind, 'RATE_LIMITED'), retryable: true };
  if (modelUnavailable) return { code: codeFor(kind, 'MODEL_UNAVAILABLE'), retryable: false };
  if (status === 401 || status === 403) {
    return { code: codeFor(kind, 'AUTH_FAILED'), retryable: false };
  }
  if (status === 404) return { code: codeFor(kind, 'MODEL_UNAVAILABLE'), retryable: false };
  if (status === 400 || status === 409 || status === 415 || status === 422) {
    return { code: codeFor(kind, 'BAD_REQUEST'), retryable: false };
  }
  if (status === 408 || status === 425 || status >= 500) return { code: failed, retryable: true };
  return { code: failed, retryable: false };
}

export function providerError(
  status: number,
  kind: ProviderKindForErrors,
  detail: string,
  hint: ProviderFailureHint = {},
): FrameScriptError {
  const { code, retryable } = classifyHttpFailure(status, kind, hint);
  return new FrameScriptError({ code, detail, recoverable: retryable });
}

/**
 * Converts a failed provider Response into a typed error while retaining only
 * non-sensitive diagnostic fields. The raw provider body is never logged or
 * surfaced: it could echo prompts, audio-derived text, or image-derived text.
 */
export async function providerResponseError(
  response: Response,
  kind: ProviderKindForErrors,
  context: string,
): Promise<FrameScriptError> {
  const hint = await readProviderFailureHint(response);
  const { code, retryable } = classifyHttpFailure(response.status, kind, hint);
  const parts = [context, `upstreamStatus=${response.status}`];
  if (hint.type) parts.push(`type=${sanitizeToken(hint.type)}`);
  if (hint.code) parts.push(`code=${sanitizeToken(hint.code)}`);
  if (hint.statusCode !== undefined && hint.statusCode !== response.status) {
    parts.push(`reportedStatus=${hint.statusCode}`);
  }
  return new FrameScriptError({ code, detail: parts.join(' '), recoverable: retryable });
}

async function readProviderFailureHint(response: Response): Promise<ProviderFailureHint> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;

  const type = firstString(record.type, nested?.type);
  const code = firstString(record.code, nested?.code);
  const rawStatus = record.statusCode ?? nested?.statusCode;
  const statusCode = Number(rawStatus);
  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(Number.isFinite(statusCode) ? { statusCode } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  return undefined;
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
}

export interface RetryOptions {
  /** Total attempts including the first. Two retries is the ceiling. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Injected in tests; production uses `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected in tests so backoff is deterministic. */
  random?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 8_000;

/** Exponential backoff with full jitter, capped. */
export function retryDelayMs(
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const random = options.random ?? Math.random;
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FrameScriptError({ code: 'ANALYSIS_ABORTED', detail: 'aborted before retry' }));
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(new FrameScriptError({ code: 'ANALYSIS_ABORTED', detail: 'aborted during retry' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `operation`, retrying only failures marked recoverable.
 *
 * An aborted operation is never retried: cancellation is a decision, not a
 * transient fault.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw new FrameScriptError({ code: 'ANALYSIS_ABORTED', detail: 'aborted before attempt' });
    }
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (isAbort(error)) throw error;
      const recoverable = FrameScriptError.is(error)
        ? error.recoverable
        : isTransientNetworkError(error);
      if (!recoverable || attempt === attempts) throw error;
      await sleep(
        retryDelayMs(attempt, {
          ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
          ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
          ...(options.random === undefined ? {} : { random: options.random }),
        }),
        options.signal,
      );
    }
  }
  throw lastError;
}

export function isAbort(error: unknown): boolean {
  if (FrameScriptError.is(error)) return error.code === 'ANALYSIS_ABORTED';
  return error instanceof Error && error.name === 'AbortError';
}

/** A `fetch` that never reached the server. Worth exactly one more try. */
export function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}
