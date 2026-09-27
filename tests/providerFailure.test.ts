import { describe, expect, it } from 'vitest';
import { classifyHttpFailure, providerFailureReason } from '@/core';
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
    expect(providerFailureReason(402)).toBe('payment_required');
    // Arbitrary provider text is never promoted to a reason.
    expect(providerFailureReason(403, { type: 'Your key sk-live-123 was revoked' })).toBeUndefined();
    expect(providerFailureReason(500, { type: 'server_error' })).toBeUndefined();
    expect(providerFailureReason(429)).toBeUndefined();
  });
});
