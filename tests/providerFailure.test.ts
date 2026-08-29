import { describe, expect, it } from 'vitest';
import { classifyHttpFailure } from '@/core';
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
});
