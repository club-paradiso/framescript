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

/**
 * Maps an HTTP status from a provider onto a FrameScript error code.
 *
 * Rate limiting gets its own code because it is the one provider failure with
 * a genuinely different user story: nothing is misconfigured, the analysis was
 * simply too fast, and the honest report is "N of M regions were transcribed".
 */
export function classifyHttpFailure(status: number, kind: ProviderKindForErrors): HttpFailure {
  const failed: FrameScriptErrorCode =
    kind === 'asr' ? 'ASR_PROVIDER_FAILED' : 'VISION_PROVIDER_FAILED';
  if (status === 429) {
    return { code: kind === 'asr' ? 'ASR_RATE_LIMITED' : failed, retryable: true };
  }
  if (status === 401 || status === 403) {
    return {
      code: kind === 'asr' ? 'ASR_NOT_CONFIGURED' : 'VISION_NOT_CONFIGURED',
      retryable: false,
    };
  }
  if (status === 408 || status === 425 || status >= 500) return { code: failed, retryable: true };
  return { code: failed, retryable: false };
}

export function providerError(
  status: number,
  kind: ProviderKindForErrors,
  detail: string,
): FrameScriptError {
  const { code, retryable } = classifyHttpFailure(status, kind);
  return new FrameScriptError({ code, detail, recoverable: retryable });
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
