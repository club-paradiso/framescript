import { describe, expect, it } from 'vitest';
import {
  FrameScriptError,
  classifyHttpFailure,
  describeFailureReason,
  parseRetryAfter,
  providerFailureReason,
  retryDelayMs,
  withRetry,
} from '@/core';
import { providerResponseError } from '../src/ai/retry';

describe('provider failure classification', () => {
  it('does not confuse configured-but-rejected credentials with missing configuration', () => {
    expect(classifyHttpFailure(401, 'asr')).toEqual({ code: 'ASR_AUTH_FAILED', retryable: false });
    expect(classifyHttpFailure(403, 'vision')).toEqual({
      code: 'VISION_AUTH_FAILED',
      retryable: false,
    });
  });

  it('treats Vercel customer verification as deployment-level model unavailability', async () => {
    expect(
      classifyHttpFailure(403, 'asr', { type: 'customer_verification_required' }),
    ).toEqual({ code: 'ASR_MODEL_UNAVAILABLE', retryable: false });
    expect(
      classifyHttpFailure(403, 'vision', { code: 'customer_verification_required' }),
    ).toEqual({ code: 'VISION_MODEL_UNAVAILABLE', retryable: false });

    const error = await providerResponseError(
      new Response(
        JSON.stringify({
          error: 'account verification text must not be retained',
          type: 'customer_verification_required',
          statusCode: 403,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
      'asr',
      'gateway=vercel model=example/transcribe',
    );

    expect(error).toMatchObject({ code: 'ASR_MODEL_UNAVAILABLE', recoverable: false });
    expect(error.detail).toContain('type=customer_verification_required');
    expect(error.detail).not.toContain('account verification text must not be retained');
  });

  it('treats malformed provider requests as deterministic failures', () => {
    expect(classifyHttpFailure(400, 'asr')).toEqual({ code: 'ASR_BAD_REQUEST', retryable: false });
    expect(classifyHttpFailure(422, 'vision')).toEqual({
      code: 'VISION_BAD_REQUEST',
      retryable: false,
    });
  });

  it('keeps rate limits and upstream outages retryable', () => {
    expect(classifyHttpFailure(429, 'asr')).toEqual({ code: 'ASR_RATE_LIMITED', retryable: true });
    expect(classifyHttpFailure(429, 'vision')).toEqual({
      code: 'VISION_RATE_LIMITED',
      retryable: true,
    });
    expect(classifyHttpFailure(503, 'vision')).toEqual({
      code: 'VISION_PROVIDER_FAILED',
      retryable: true,
    });
  });

  it('recognizes the Gateway allowlist response without retaining its body', async () => {
    const error = await providerResponseError(
      new Response(
        JSON.stringify({
          error: 'do not retain this provider message',
          type: 'no_providers_available',
          statusCode: 403,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
      'vision',
      'model=example/model frames=3 frameBytes=1234',
    );

    expect(error).toMatchObject({ code: 'VISION_MODEL_UNAVAILABLE', recoverable: false });
    expect(error.detail).toContain('type=no_providers_available');
    expect(error.detail).not.toContain('do not retain this provider message');
  });

  it('treats a 402 as a non-retryable account gate, not a transient provider failure', async () => {
    // OpenRouter answers 402 when the key's account has insufficient credits;
    // Vercel AI Gateway answers 402 insufficient_funds. Retrying cannot help.
    expect(classifyHttpFailure(402, 'asr')).toEqual({
      code: 'ASR_MODEL_UNAVAILABLE',
      retryable: false,
    });
    expect(classifyHttpFailure(402, 'vision', { type: 'insufficient_funds' })).toEqual({
      code: 'VISION_MODEL_UNAVAILABLE',
      retryable: false,
    });

    const error = await providerResponseError(
      new Response(
        JSON.stringify({ error: { message: 'Insufficient credits for sk-or-secret', code: 402 } }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
      'asr',
      'model=openai/gpt-4o-transcribe',
    );
    expect(error).toMatchObject({
      code: 'ASR_MODEL_UNAVAILABLE',
      recoverable: false,
      reason: 'payment_required',
    });
    expect(error.detail).toContain('upstreamStatus=402');
    expect(error.detail).not.toContain('sk-or-secret');
  });

  it('only ever surfaces allowlisted refusal reasons', () => {
    expect(providerFailureReason(403, { type: 'customer_verification_required' })).toBe(
      'customer_verification_required',
    );
    expect(providerFailureReason(402, { type: 'insufficient_funds' })).toBe('insufficient_funds');
    expect(providerFailureReason(403, { type: 'no_providers_available' })).toBe(
      'no_providers_available',
    );
    expect(providerFailureReason(404, { code: 'model_not_found' })).toBe('model_not_found');
    expect(providerFailureReason(400, { code: 'unsupported_modality' })).toBe('unsupported_modality');
    expect(providerFailureReason(400, { code: 'modality_not_supported' })).toBe('unsupported_modality');
    expect(providerFailureReason(402)).toBe('payment_required');
    // Arbitrary provider text is never promoted to a reason.
    expect(providerFailureReason(403, { type: 'Your key sk-live-123 was revoked' })).toBeUndefined();
    expect(providerFailureReason(500, { type: 'server_error' })).toBeUndefined();
    expect(providerFailureReason(429)).toBeUndefined();
  });

  it('parses Retry-After header for integer seconds and HTTP dates, clamping safely', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter('  30  ')).toBe(30);
    expect(parseRetryAfter('999999')).toBe(120); // Clamped to 120
    expect(parseRetryAfter('-5')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not-a-number')).toBeUndefined();

    // Future HTTP date
    const futureDate = new Date(Date.now() + 45_000).toUTCString();
    const parsedDateSeconds = parseRetryAfter(futureDate);
    expect(parsedDateSeconds).toBeGreaterThanOrEqual(40);
    expect(parsedDateSeconds).toBeLessThanOrEqual(46);
  });

  it('extracts Retry-After header into FrameScriptError.retryAfterSeconds', async () => {
    const error = await providerResponseError(
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '25',
        },
      }),
      'asr',
      'model=openai/gpt-4o-transcribe',
    );

    expect(error.code).toBe('ASR_RATE_LIMITED');
    expect(error.recoverable).toBe(true);
    expect(error.retryAfterSeconds).toBe(25);
    expect(error.detail).toContain('retryAfter=25s');
  });

  it('honors retryAfterMs in retryDelayMs with bounded ceiling', () => {
    const delay = retryDelayMs(1, { retryAfterMs: 4000, random: () => 0.5 });
    // 4000 * (1 + 0.1 * 0.5) = 4000 * 1.05 = 4200
    expect(delay).toBe(4200);

    // Honors 20s provider backoff without prematurely capping to 8s
    const twentySec = retryDelayMs(1, { retryAfterMs: 20000, random: () => 0 });
    expect(twentySec).toBe(20000);

    // Caps at MAX_RETRY_AFTER_SECONDS (120s)
    const capped = retryDelayMs(1, { retryAfterMs: 200000, random: () => 0 });
    expect(capped).toBe(120000);
  });

  it('invokes onRetry callback in withRetry before sleeping', async () => {
    let attemptsCount = 0;
    const retryCalls: { attempt: number; delay: number }[] = [];
    const result = await withRetry(
      async () => {
        attemptsCount++;
        if (attemptsCount < 2) {
          throw new FrameScriptError({
            code: 'ASR_RATE_LIMITED',
            detail: '429 rate limit',
            recoverable: true,
            retryAfterSeconds: 5,
          });
        }
        return 'success';
      },
      {
        attempts: 3,
        random: () => 0,
        sleep: async () => {},
        onRetry: (_err, attempt, delay) => {
          retryCalls.push({ attempt, delay });
        },
      },
    );

    expect(result).toBe('success');
    expect(attemptsCount).toBe(2);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]?.attempt).toBe(1);
    expect(retryCalls[0]?.delay).toBe(5000);
  });

  it('maps all allowlisted refusal reasons to human-friendly explanations', () => {
    expect(describeFailureReason('payment_required')).toMatch(/insufficient credits/i);
    expect(describeFailureReason('insufficient_funds')).toMatch(/insufficient credits/i);
    expect(describeFailureReason('customer_verification_required')).toMatch(/verification/i);
    expect(describeFailureReason('no_providers_available')).toMatch(/allowlist/i);
    expect(describeFailureReason('model_not_found')).toMatch(/withdrawn/i);
    expect(describeFailureReason('unsupported_modality')).toMatch(/modality/i);
  });
});
