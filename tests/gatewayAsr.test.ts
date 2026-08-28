import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAsrConfig } from '../api/_lib/config';
import { transcribeViaGateway } from '../api/_lib/gatewayAsr';

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidc = process.env.VERCEL_OIDC_TOKEN;
const originalFrameScriptKey = process.env.FRAMESCRIPT_ASR_API_KEY;
const originalFrameScriptModel = process.env.FRAMESCRIPT_ASR_MODEL;
const originalGatewayModel = process.env.FRAMESCRIPT_GATEWAY_ASR_MODEL;
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
  restore('FRAMESCRIPT_ASR_MODEL', originalFrameScriptModel);
  restore('FRAMESCRIPT_GATEWAY_ASR_MODEL', originalGatewayModel);

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
});

describe('Vercel AI Gateway transcription transport', () => {
  it('sends base64 WAV audio with model and OIDC authentication', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer oidc-test-token');
      expect(headers.get('ai-model-id')).toBe('openai/gpt-4o-transcribe');
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

  it('maps Gateway rate limiting onto the existing retryable ASR error', async () => {
    await expect(
      transcribeViaGateway({
        wav: new Uint8Array([1, 2, 3, 4]),
        endpoint: 'https://ai-gateway.vercel.sh/v4/ai/transcription-model',
        token: 'oidc-test-token',
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
