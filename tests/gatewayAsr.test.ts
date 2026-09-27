import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAsrConfig, readVisionConfig } from '../api/_lib/config';
import { transcribeViaGateway } from '../api/_lib/gatewayAsr';

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidc = process.env.VERCEL_OIDC_TOKEN;
const originalFrameScriptKey = process.env.FRAMESCRIPT_ASR_API_KEY;
const originalFrameScriptEndpoint = process.env.FRAMESCRIPT_ASR_ENDPOINT;
const originalFrameScriptModel = process.env.FRAMESCRIPT_ASR_MODEL;
const originalGatewayModel = process.env.FRAMESCRIPT_GATEWAY_ASR_MODEL;
const originalVisionKey = process.env.FRAMESCRIPT_VISION_API_KEY;
const originalVisionProvider = process.env.FRAMESCRIPT_VISION_PROVIDER;
const originalVisionEndpoint = process.env.FRAMESCRIPT_VISION_ENDPOINT;
const originalVisionModel = process.env.FRAMESCRIPT_VISION_MODEL;
const originalGatewayVisionModel = process.env.FRAMESCRIPT_GATEWAY_VISION_MODEL;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalOpenRouterVisionModel = process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL;
const originalVercel = process.env.VERCEL;
const requestContextSymbol = Symbol.for('@vercel/request-context');
const originalRequestContext = (
  globalThis as typeof globalThis & {
    [requestContextSymbol]?: { get?: () => { headers?: Record<string, string> } };
  }
)[requestContextSymbol];

afterEach(() => {
  restore('AI_GATEWAY_API_KEY', originalGatewayKey);
  restore('VERCEL_OIDC_TOKEN', originalOidc);
  restore('FRAMESCRIPT_ASR_API_KEY', originalFrameScriptKey);
  restore('FRAMESCRIPT_ASR_ENDPOINT', originalFrameScriptEndpoint);
  restore('FRAMESCRIPT_ASR_MODEL', originalFrameScriptModel);
  restore('FRAMESCRIPT_GATEWAY_ASR_MODEL', originalGatewayModel);
  restore('FRAMESCRIPT_VISION_API_KEY', originalVisionKey);
  restore('FRAMESCRIPT_VISION_PROVIDER', originalVisionProvider);
  restore('FRAMESCRIPT_VISION_ENDPOINT', originalVisionEndpoint);
  restore('FRAMESCRIPT_VISION_MODEL', originalVisionModel);
  restore('FRAMESCRIPT_GATEWAY_VISION_MODEL', originalGatewayVisionModel);
  restore('OPENROUTER_API_KEY', originalOpenRouterKey);
  restore('FRAMESCRIPT_OPENROUTER_VISION_MODEL', originalOpenRouterVisionModel);
  restore('VERCEL', originalVercel);

  const runtime = globalThis as typeof globalThis & {
    [requestContextSymbol]?: { get?: () => { headers?: Record<string, string> } };
  };
  if (originalRequestContext === undefined) delete runtime[requestContextSymbol];
  else runtime[requestContextSymbol] = originalRequestContext;
});

describe('Vercel AI Gateway ASR configuration', () => {
  it('uses deployment OIDC when no long-lived ASR key is configured', () => {
    delete process.env.FRAMESCRIPT_ASR_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.FRAMESCRIPT_GATEWAY_ASR_MODEL;
    process.env.VERCEL_OIDC_TOKEN = 'oidc-test-token';

    expect(readAsrConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      apiKey: 'oidc-test-token',
      gatewayAuthMethod: 'oidc',
      model: 'openai/gpt-4o-transcribe',
    });
  });

  it('uses the per-request Vercel OIDC context when the environment snapshot is absent', () => {
    delete process.env.FRAMESCRIPT_ASR_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.FRAMESCRIPT_GATEWAY_ASR_MODEL;

    const runtime = globalThis as typeof globalThis & {
      [requestContextSymbol]?: { get?: () => { headers?: Record<string, string> } };
    };
    runtime[requestContextSymbol] = {
      get: () => ({ headers: { 'x-vercel-oidc-token': 'request-context-token' } }),
    };

    expect(readAsrConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      apiKey: 'request-context-token',
      gatewayAuthMethod: 'oidc',
      model: 'openai/gpt-4o-transcribe',
    });
  });

  it('marks an explicit AI Gateway API key as api-key auth', () => {
    delete process.env.FRAMESCRIPT_ASR_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';

    expect(readAsrConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      apiKey: 'gateway-key',
      gatewayAuthMethod: 'api-key',
    });
  });

  it('routes ASR through Gateway OIDC once the explicit override key is removed', () => {
    // Production carried an explicit OpenRouter transcription override whose
    // account returned 402. Only the key's presence decides precedence, so
    // leftover endpoint/model variables must not keep the explicit path alive.
    delete process.env.FRAMESCRIPT_ASR_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.FRAMESCRIPT_GATEWAY_ASR_MODEL;
    process.env.FRAMESCRIPT_ASR_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
    process.env.FRAMESCRIPT_ASR_MODEL = 'openai/gpt-4o-transcribe';
    process.env.VERCEL_OIDC_TOKEN = 'oidc-test-token';

    expect(readAsrConfig()).toEqual({
      provider: 'vercel-ai-gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
      apiKey: 'oidc-test-token',
      gatewayAuthMethod: 'oidc',
      model: 'openai/gpt-4o-transcribe',
    });
  });

  it('keeps an explicitly configured OpenAI-compatible endpoint authoritative', () => {
    process.env.VERCEL_OIDC_TOKEN = 'oidc-test-token';
    process.env.FRAMESCRIPT_ASR_API_KEY = 'explicit-key';
    process.env.FRAMESCRIPT_ASR_MODEL = 'custom-model';

    expect(readAsrConfig()).toMatchObject({
      provider: 'openai-compatible',
      apiKey: 'explicit-key',
      model: 'custom-model',
    });
  });

  it('removes the Gateway namespace when a GPT transcription model is sent directly to OpenAI', () => {
    process.env.FRAMESCRIPT_ASR_API_KEY = 'explicit-key';
    process.env.FRAMESCRIPT_ASR_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
    process.env.FRAMESCRIPT_ASR_MODEL = 'openai/gpt-4o-transcribe';

    expect(readAsrConfig()).toMatchObject({
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'gpt-4o-transcribe',
    });
  });
});

describe('Vercel AI Gateway vision configuration', () => {
  it('hard-routes Vercel production to the pinned $0 Gateway vision model', () => {
    process.env.VERCEL = '1';
    delete process.env.FRAMESCRIPT_VISION_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';

    expect(readVisionConfig()).toEqual({
      provider: 'vercel-ai-gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      apiKey: 'gateway-key',
      gatewayAuthMethod: 'api-key',
      model: 'stealth/pixel-canary',
      // The live catalog entry does not declare response_format; reasoning is
      // switched off so the token budget goes to the JSON observation.
      requestOptions: { jsonResponseFormat: false, reasoningEffort: 'none' },
    });
  });

  it('never lets paid-capable explicit vision variables win in Vercel production', () => {
    process.env.VERCEL = '1';
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.FRAMESCRIPT_VISION_PROVIDER = 'openai-compatible';
    process.env.FRAMESCRIPT_VISION_API_KEY = 'explicit-vision-key';
    process.env.FRAMESCRIPT_VISION_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
    process.env.FRAMESCRIPT_VISION_MODEL = 'google/gemini-3.5-flash-lite';
    process.env.FRAMESCRIPT_GATEWAY_VISION_MODEL = 'minimax/minimax-m3';

    expect(readVisionConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      apiKey: 'gateway-key',
      model: 'stealth/pixel-canary',
    });
  });

  it('refuses vision in Vercel production rather than use a paid explicit override', () => {
    // No zero-cost route: no OpenRouter key, no Gateway key, no OIDC token.
    process.env.VERCEL = '1';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.FRAMESCRIPT_VISION_PROVIDER = 'anthropic';
    process.env.FRAMESCRIPT_VISION_API_KEY = 'explicit-vision-key';
    process.env.FRAMESCRIPT_VISION_MODEL = 'claude-paid-model';

    expect(readVisionConfig()).toEqual({
      error:
        'Production vision needs a zero-cost route: AI Gateway OIDC (or AI_GATEWAY_API_KEY), or OPENROUTER_API_KEY. Paid FRAMESCRIPT_VISION_* overrides are not used on Vercel.',
    });
  });

  it('uses the hard-free OpenRouter path in Vercel production when its key exists', () => {
    process.env.VERCEL = '1';
    delete process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL;
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.FRAMESCRIPT_VISION_API_KEY = 'explicit-vision-key';
    process.env.FRAMESCRIPT_VISION_MODEL = 'google/gemini-3.5-flash-lite';

    expect(readVisionConfig()).toEqual({
      provider: 'openai-compatible',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: 'openrouter-key',
      model: 'google/gemma-4-31b-it:free',
    });
  });

  it('refuses a paid OpenRouter vision model in Vercel production instead of falling back', () => {
    process.env.VERCEL = '1';
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL = 'google/gemini-3.5-flash-lite';

    expect(readVisionConfig()).toEqual({
      error:
        'FRAMESCRIPT_OPENROUTER_VISION_MODEL must use a :free model (or openrouter/free) when OPENROUTER_API_KEY is configured.',
    });
  });

  it('uses the per-request Vercel OIDC context when no long-lived vision key exists', () => {
    delete process.env.FRAMESCRIPT_VISION_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.FRAMESCRIPT_GATEWAY_VISION_MODEL;

    const runtime = globalThis as typeof globalThis & {
      [requestContextSymbol]?: { get?: () => { headers?: Record<string, string> } };
    };
    runtime[requestContextSymbol] = {
      get: () => ({ headers: { 'x-vercel-oidc-token': 'request-context-token' } }),
    };

    expect(readVisionConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      apiKey: 'request-context-token',
      gatewayAuthMethod: 'oidc',
      model: 'google/gemini-3.5-flash-lite',
    });
  });

  it('prefers the hard-free OpenRouter path when an OpenRouter key is configured', () => {
    delete process.env.FRAMESCRIPT_VISION_API_KEY;
    delete process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL;
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';

    expect(readVisionConfig()).toMatchObject({
      provider: 'openai-compatible',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: 'openrouter-key',
      model: 'google/gemma-4-31b-it:free',
    });
  });

  it('rejects paid OpenRouter vision models when the hard-free path is enabled', () => {
    delete process.env.FRAMESCRIPT_VISION_API_KEY;
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL = 'openai/gpt-5.6-luna';

    expect(readVisionConfig()).toEqual({
      error:
        'FRAMESCRIPT_OPENROUTER_VISION_MODEL must use a :free model (or openrouter/free) when OPENROUTER_API_KEY is configured.',
    });
  });

  it('supports overriding only the Gateway vision model when OpenRouter is absent', () => {
    delete process.env.FRAMESCRIPT_VISION_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.FRAMESCRIPT_GATEWAY_VISION_MODEL = 'openai/gpt-5.6-luna';

    expect(readVisionConfig()).toMatchObject({
      provider: 'vercel-ai-gateway',
      apiKey: 'gateway-key',
      gatewayAuthMethod: 'api-key',
      model: 'openai/gpt-5.6-luna',
    });
  });

  it('keeps an explicitly configured vision provider authoritative', () => {
    process.env.AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.FRAMESCRIPT_VISION_PROVIDER = 'openai-compatible';
    process.env.FRAMESCRIPT_VISION_API_KEY = 'explicit-vision-key';
    process.env.FRAMESCRIPT_VISION_ENDPOINT = 'https://example.test/v1/chat/completions';
    process.env.FRAMESCRIPT_VISION_MODEL = 'custom-vision-model';

    expect(readVisionConfig()).toMatchObject({
      provider: 'openai-compatible',
      apiKey: 'explicit-vision-key',
      endpoint: 'https://example.test/v1/chat/completions',
      model: 'custom-vision-model',
    });
  });
});

describe('Vercel AI Gateway transcription transport', () => {
  it('matches the official v4 Gateway envelope for base64 WAV audio', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer oidc-test-token');
      expect(headers.get('ai-gateway-protocol-version')).toBe('0.0.1');
      expect(headers.get('ai-gateway-auth-method')).toBe('oidc');
      expect(headers.get('ai-model-id')).toBe('openai/gpt-4o-transcribe');
      expect(headers.get('ai-transcription-model-specification-version')).toBe('4');
      const body = JSON.parse(String(init?.body)) as { audio: string; mediaType: string };
      expect(body.mediaType).toBe('audio/wav');
      expect(body.audio).toBe('AQIDBA==');

      return new Response(
        JSON.stringify({
          text: '안녕하세요. 제주에 오신 것을 환영합니다.',
          language: 'Korean',
          segments: [
            {
              text: '안녕하세요.',
              startSecond: 0,
              endSecond: 0.8,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await transcribeViaGateway({
      wav: new Uint8Array([1, 2, 3, 4]),
      endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
      token: 'oidc-test-token',
      authMethod: 'oidc',
      model: 'openai/gpt-4o-transcribe',
      languageHint: 'ko',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      text: '안녕하세요. 제주에 오신 것을 환영합니다.',
      language: 'ko',
      segments: [{ text: '안녕하세요.', startMs: 0, endMs: 800 }],
    });
  });

  it('maps a deterministic Gateway 400 to ASR_BAD_REQUEST without retry semantics', async () => {
    await expect(
      transcribeViaGateway({
        wav: new Uint8Array([1, 2, 3, 4]),
        endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
        token: 'oidc-test-token',
        authMethod: 'oidc',
        model: 'openai/gpt-4o-transcribe',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ type: 'invalid_request_error', statusCode: 400 }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'ASR_BAD_REQUEST', recoverable: false });
  });

  it('distinguishes a Gateway allowlist 403 from missing configuration', async () => {
    await expect(
      transcribeViaGateway({
        wav: new Uint8Array([1, 2, 3, 4]),
        endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
        token: 'oidc-test-token',
        authMethod: 'oidc',
        model: 'openai/gpt-4o-transcribe',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ type: 'no_providers_available', statusCode: 403 }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'ASR_MODEL_UNAVAILABLE', recoverable: false });
  });

  it('reports a Gateway insufficient-funds 402 as a non-retryable account gate', async () => {
    await expect(
      transcribeViaGateway({
        wav: new Uint8Array([1, 2, 3, 4]),
        endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
        token: 'oidc-test-token',
        authMethod: 'oidc',
        model: 'openai/gpt-4o-transcribe',
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              error: { message: 'add credits at a private team url', type: 'insufficient_funds' },
            }),
            { status: 402, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: 'ASR_MODEL_UNAVAILABLE',
      recoverable: false,
      reason: 'insufficient_funds',
    });
  });

  it('maps Gateway rate limiting onto the retryable ASR error', async () => {
    await expect(
      transcribeViaGateway({
        wav: new Uint8Array([1, 2, 3, 4]),
        endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
        token: 'oidc-test-token',
        authMethod: 'oidc',
        model: 'openai/gpt-4o-transcribe',
        fetchImpl: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'ASR_RATE_LIMITED', recoverable: true });
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
