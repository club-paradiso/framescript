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

import {
  FrameScriptError,
  type FrameScriptErrorCode,
  type ProviderFailureReason,
} from '../utils/errors.js';

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

const REASON_TOKENS: readonly ProviderFailureReason[] = [
  'customer_verification_required',
  'insufficient_funds',
  'payment_required',
  'no_providers_available',
  'model_not_found',
  'unsupported_modality',
];

export const MAX_RETRY_AFTER_SECONDS = 120;

/**
 * Parses a Retry-After header (either integer seconds or HTTP-date).
 * Clamps to a sane range [0, 120] seconds to prevent rogue headers from
 * hanging the worker. Returns undefined if unparseable.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 0 ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.round(seconds)) : undefined;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diffSeconds = Math.ceil((dateMs - Date.now()) / 1000);
    return Math.max(0, Math.min(120, diffSeconds));
  }

  return undefined;
}

/**
 * Picks the allowlisted refusal reason out of a provider's error type/code.
 *
 * Only exact members of `ProviderFailureReason` (or a `model_not_found`
 * variant) are recognized; any other provider text is discarded. A bare 402
 * with no recognizable type still means the provider account cannot pay for
 * the request, so it is reported as `payment_required`.
 */
export function providerFailureReason(
  status: number,
  hint: ProviderFailureHint = {},
): ProviderFailureReason | undefined {
  const tokens = [hint.type, hint.code].map((value) => value?.trim().toLowerCase() ?? '');
  for (const reason of REASON_TOKENS) {
    if (tokens.includes(reason)) return reason;
  }
  if (tokens.some((token) => token.includes('model_not_found'))) return 'model_not_found';
  if (tokens.some((token) => token.includes('unsupported_modality') || token.includes('modality_not_supported'))) {
    return 'unsupported_modality';
  }
  if (status === 402) return 'payment_required';
  return undefined;
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
 * complete account verification before paid inference is permitted, and 402 +
 * `insufficient_funds` when the team has no credit balance. OpenRouter returns
 * 402 when the key's account has insufficient credits. None of these is fixed
 * by retrying the same request or rotating model slugs, so all are represented
 * as deployment-level model unavailability rather than a bad API credential or
 * a transient provider failure.
 */
export function classifyHttpFailure(
  status: number,
  kind: ProviderKindForErrors,
  hint: ProviderFailureHint = {},
): HttpFailure {
  const failed = codeFor(kind, 'PROVIDER_FAILED');
  const normalizedCode = hint.code?.trim().toLowerCase() ?? '';
  const modelUnavailable =
    providerFailureReason(status, hint) !== undefined ||
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
  const reason = providerFailureReason(status, hint);
  return new FrameScriptError({
    code,
    detail,
    recoverable: retryable,
    ...(reason ? { reason } : {}),
  });
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
  const reason = providerFailureReason(response.status, hint);
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
  const parts = [context, `upstreamStatus=${response.status}`];
  if (hint.type) parts.push(`type=${sanitizeToken(hint.type)}`);
  if (hint.code) parts.push(`code=${sanitizeToken(hint.code)}`);
  if (hint.statusCode !== undefined && hint.statusCode !== response.status) {
    parts.push(`reportedStatus=${hint.statusCode}`);
  }
  if (retryAfterSeconds !== undefined) {
    parts.push(`retryAfter=${retryAfterSeconds}s`);
  }
  return new FrameScriptError({
    code,
    detail: parts.join(' '),
    recoverable: retryable,
    ...(reason ? { reason } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
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
  /** Invoked before sleeping for a retry attempt. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 8_000;

/** Exponential backoff with full jitter, capped, optionally honouring retryAfterMs. */
export function retryDelayMs(
  attempt: number,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
    retryAfterMs?: number;
  } = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const random = options.random ?? Math.random;

  if (options.retryAfterMs !== undefined && options.retryAfterMs > 0) {
    const jittered = options.retryAfterMs * (1 + 0.1 * random());
    // Honor the provider's requested Retry-After, capped at MAX_RETRY_AFTER_SECONDS (120s)
    // rather than the default exponential backoff ceiling (8s).
    const maxRetryAfter = Math.max(max, MAX_RETRY_AFTER_SECONDS * 1000);
    return Math.round(Math.min(maxRetryAfter, Math.max(base, jittered)));
  }

  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
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
      const retryAfterSeconds =
        FrameScriptError.is(error) && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds
          : undefined;
      const delay = retryDelayMs(attempt, {
        ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
        ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(retryAfterSeconds !== undefined ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
      });
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
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
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    if (name === 'networkerror' || name === 'fetcherror') return true;
    if (message.includes('network error') || message.includes('failed to fetch')) return true;
  }
  return false;
}
