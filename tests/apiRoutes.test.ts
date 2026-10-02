/**
 * The server routes.
 *
 * These are the only part of FrameScript that ever holds a provider
 * credential, so the tests are as much about what does *not* come back as
 * about what does: no key, no endpoint, no provider response body, and no
 * cacheable response.
 *
 * The routes are plain `(Request) => Response` functions, so they are tested
 * directly rather than through a server. The provider is stubbed at `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import capabilities from '../api/capabilities';
import transcribe from '../api/transcribe';
import analyzeFrame from '../api/analyze-frame';
import { encodeAsrWindow } from '@/core';

const SECRET = 'sk-test-secret-value-do-not-leak';
const ENDPOINT = 'https://provider.internal.example/v1/audio/transcriptions';
const VISION_ENDPOINT = 'https://vision.internal.example/v1/messages';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function configureAsr(): void {
  process.env.FRAMESCRIPT_ASR_PROVIDER = 'openai-compatible';
  process.env.FRAMESCRIPT_ASR_API_KEY = SECRET;
  process.env.FRAMESCRIPT_ASR_ENDPOINT = ENDPOINT;
  process.env.FRAMESCRIPT_ASR_MODEL = 'whisper-1';
}

function configureVision(): void {
  process.env.FRAMESCRIPT_VISION_PROVIDER = 'anthropic';
  process.env.FRAMESCRIPT_VISION_API_KEY = SECRET;
  process.env.FRAMESCRIPT_VISION_ENDPOINT = VISION_ENDPOINT;
  process.env.FRAMESCRIPT_VISION_MODEL = 'claude-test';
}

function clearConfig(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FRAMESCRIPT_')) delete process.env[key];
  }
}

function wavWindow(seconds = 1): Uint8Array {
  const samples = new Float32Array(Math.round(16_000 * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 16) * 0.3;
  return encodeAsrWindow(samples, 16_000)!;
}

function transcribeRequest(
  overrides: { wav?: Uint8Array; startMs?: string; endMs?: string; language?: string } = {},
): Request {
  const form = new FormData();
  const wav = overrides.wav ?? wavWindow();
  const buffer = new ArrayBuffer(wav.byteLength);
  new Uint8Array(buffer).set(wav);
  form.append('audio', new Blob([buffer], { type: 'audio/wav' }), 'window.wav');
  form.append('startMs', overrides.startMs ?? '1000');
  form.append('endMs', overrides.endMs ?? '3000');
  if (overrides.language) form.append('language', overrides.language);
  return new Request('https://studio.example/api/transcribe', { method: 'POST', body: form });
}

const frame = {
  timestamp: 1_500,
  // A one-pixel JPEG is enough: the route validates size and type, never pixels.
  data: 'AAAA',
  mimeType: 'image/jpeg',
  width: 512,
  height: 288,
};

function frameRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://studio.example/api/analyze-frame', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: 1_000, end: 3_000, frames: [frame], ...body }),
  });
}

beforeEach(() => {
  clearConfig();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('GET /api/capabilities', () => {
  it('reports nothing configured when no environment is set', async () => {
    const response = capabilities(new Request('https://studio.example/api/capabilities'));
    const body = (await response.json()) as Record<string, never>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      transcription: { configured: false },
      vision: { configured: false },
    });
  });

  it('reports provider and model but never the key or the endpoint', async () => {
    configureAsr();
    configureVision();
    const response = capabilities(new Request('https://studio.example/api/capabilities'));
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({
      transcription: { configured: true, provider: 'openai-compatible', model: 'whisper-1' },
      vision: { configured: true, provider: 'anthropic', model: 'claude-test' },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('provider.internal.example');
    expect(text).not.toContain('vision.internal.example');
  });

  it('is never cached', () => {
    const response = capabilities(new Request('https://studio.example/api/capabilities'));
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('rejects a method that is not GET', () => {
    const response = capabilities(
      new Request('https://studio.example/api/capabilities', { method: 'POST' }),
    );
    expect(response.status).toBe(405);
  });
});

describe('POST /api/transcribe', () => {
  it('reports a precise, non-secret configuration status when unconfigured', async () => {
    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('ASR_NOT_CONFIGURED');
    expect(body.message).toMatch(/FRAMESCRIPT_ASR_API_KEY/);
  });

  it('forwards the window to the provider and returns the transcript', async () => {
    configureAsr();
    const seen: { url: string; auth: string | null; model: unknown } = {
      url: '',
      auth: null,
      model: null,
    };
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.auth = new Headers(init?.headers).get('authorization');
      seen.model = (init?.body as FormData).get('model');
      return new Response(
        JSON.stringify({
          text: 'We are out of milk.',
          language: 'en',
          segments: [{ start: 0.1, end: 1.4, text: 'We are out of milk.' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest({ language: 'en' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(seen.url).toBe(ENDPOINT);
    expect(seen.auth).toBe(`Bearer ${SECRET}`);
    expect(seen.model).toBe('whisper-1');
    expect(body).toMatchObject({
      start: 1_000,
      end: 3_000,
      text: 'We are out of milk.',
      language: 'en',
    });
    expect(body.segments).toEqual([{ startMs: 100, endMs: 1_400, text: 'We are out of milk.' }]);
  });

  it('returns an empty transcript rather than inventing a line', async () => {
    configureAsr();
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const body = (await (await transcribe(transcribeRequest())).json()) as { text: string };
    expect(body.text).toBe('');
  });

  it('maps a provider 429 to a retryable 429 without echoing its body', async () => {
    configureAsr();
    globalThis.fetch = vi.fn(
      async () => new Response(`quota exhausted for ${SECRET}`, { status: 429 }),
    ) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    const text = await response.text();
    expect(response.status).toBe(429);
    expect(JSON.parse(text).code).toBe('ASR_RATE_LIMITED');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('quota exhausted');
  });

  it('reports an out-of-credit provider as a non-retryable 503 with a safe reason', async () => {
    configureAsr();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: `Insufficient credits for ${SECRET}`, code: 402 } }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      code: 'ASR_MODEL_UNAVAILABLE',
      message: expect.any(String),
      reason: 'payment_required',
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Insufficient credits');
  });

  it('rejects a window longer than the endpoint accepts', async () => {
    configureAsr();
    const response = await transcribe(transcribeRequest({ startMs: '0', endMs: '90000' }));
    expect(response.status).toBe(400);
  });

  it('rejects a non-WAV payload', async () => {
    configureAsr();
    const response = await transcribe(transcribeRequest({ wav: new Uint8Array(64) }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/not a WAV/i);
  });

  it('rejects an oversized declared body before reading it', async () => {
    configureAsr();
    const request = new Request('https://studio.example/api/transcribe', {
      method: 'POST',
      headers: { 'content-length': String(64 * 1024 * 1024), 'content-type': 'text/plain' },
      body: 'x',
    });
    expect((await transcribe(request)).status).toBe(413);
  });

  it('rejects a method that is not POST', async () => {
    expect((await transcribe(new Request('https://studio.example/api/transcribe'))).status).toBe(
      405,
    );
  });

  it('never caches a response carrying a transcript', async () => {
    configureAsr();
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ text: 'secret dialogue' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const response = await transcribe(transcribeRequest());
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('returns ASR_BAD_REQUEST on invalid audio input instead of generic error', async () => {
    configureAsr();
    const response = await transcribe(transcribeRequest({ wav: new Uint8Array(10) }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('ASR_BAD_REQUEST');
  });

  it('forwards Retry-After header and retryAfterSeconds on 429 rate limit', async () => {
    configureAsr();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    ) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    const body = (await response.json()) as { code: string; retryAfterSeconds?: number };
    expect(body.code).toBe('ASR_RATE_LIMITED');
    expect(body.retryAfterSeconds).toBe(30);
  });

  it('falls back to cheaper openai/gpt-4o-mini-transcribe when gpt-4o-transcribe fails on Gateway', async () => {
    process.env.AI_GATEWAY_API_KEY = SECRET;
    delete process.env.FRAMESCRIPT_ASR_API_KEY;

    let callCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);
      const model = headers.get('ai-model-id');
      if (model === 'openai/gpt-4o-transcribe') {
        return new Response(
          JSON.stringify({ error: { message: 'Model unavailable', type: 'model_unavailable' } }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      if (model === 'openai/gpt-4o-mini-transcribe') {
        return new Response(
          JSON.stringify({
            text: 'Fallback transcript succeeds.',
            language: 'en',
            segments: [{ start: 0, end: 1, text: 'Fallback transcript succeeds.' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
    const body = (await response.json()) as { text: string; model: string };
    expect(body.text).toBe('Fallback transcript succeeds.');
    expect(body.model).toBe('openai/gpt-4o-mini-transcribe');
  });

  it('does not fall back to mini transcribe when Gateway returns account-level refusal', async () => {
    process.env.AI_GATEWAY_API_KEY = SECRET;
    delete process.env.FRAMESCRIPT_ASR_API_KEY;

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          error: { message: 'Verification needed', type: 'customer_verification_required' },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(503);
    expect(callCount).toBe(1);
    const body = (await response.json()) as { code: string; reason?: string };
    expect(body.code).toBe('ASR_MODEL_UNAVAILABLE');
    expect(body.reason).toBe('customer_verification_required');
  });

  it('does not fall back to mini transcribe on rate limits (429) to avoid multiplying load', async () => {
    process.env.AI_GATEWAY_API_KEY = SECRET;
    delete process.env.FRAMESCRIPT_ASR_API_KEY;

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { message: 'Too many requests' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
      );
    }) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(429);
    expect(callCount).toBe(1);
    const body = (await response.json()) as { code: string; retryAfterSeconds?: number };
    expect(body.code).toBe('ASR_RATE_LIMITED');
    expect(body.retryAfterSeconds).toBe(30);
  });

  it('refuses automatic ASR fallback when FRAMESCRIPT_DISABLE_ASR_FALLBACK=1', async () => {
    process.env.AI_GATEWAY_API_KEY = SECRET;
    process.env.FRAMESCRIPT_DISABLE_ASR_FALLBACK = '1';
    delete process.env.FRAMESCRIPT_ASR_API_KEY;

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { message: 'Model unavailable', code: 'model_unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const response = await transcribe(transcribeRequest());
    expect(response.status).toBe(503);
    expect(callCount).toBe(1);
    delete process.env.FRAMESCRIPT_DISABLE_ASR_FALLBACK;
  });
});

describe('POST /api/analyze-frame', () => {
  it('reports not-configured rather than failing', async () => {
    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('VISION_NOT_CONFIGURED');
  });

  it('validates the provider response and returns structured evidence', async () => {
    configureVision();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  actions: [
                    {
                      offsetMs: 100,
                      description: 'A door opens',
                      participants: [],
                      confidence: 'medium',
                    },
                  ],
                  characters: [],
                  settingChanges: [],
                  text: [],
                  uncertainties: [],
                }),
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { analysis: { actions: { description: string }[] } };
    expect(body.analysis.actions[0]!.description).toBe('A door opens');
  });

  it('discards a response that fails schema validation instead of guessing', async () => {
    configureVision();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'here you go: not json at all' }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe('AI_RESPONSE_INVALID');
  });

  it('rejects more frames than the per-request cap', async () => {
    configureVision();
    const response = await analyzeFrame(frameRequest({ frames: Array(20).fill(frame) }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/At most/);
  });

  it('rejects a frame type that is not an image', async () => {
    configureVision();
    const response = await analyzeFrame(
      frameRequest({ frames: [{ ...frame, mimeType: 'application/octet-stream' }] }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a frame timestamped outside the window it claims to belong to', async () => {
    configureVision();
    const response = await analyzeFrame(
      frameRequest({ frames: [{ ...frame, timestamp: 90_000 }] }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/outside the window/i);
  });

  it('rejects an oversized frame before decoding it', async () => {
    configureVision();
    const response = await analyzeFrame(
      frameRequest({ frames: [{ ...frame, data: 'A'.repeat(2 * 1024 * 1024) }] }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/size limit/i);
  });

  it('never echoes the provider error body or the key', async () => {
    configureVision();
    globalThis.fetch = vi.fn(
      async () => new Response(`invalid x-api-key ${SECRET}`, { status: 400 }),
    ) as unknown as typeof fetch;
    const text = await (await analyzeFrame(frameRequest())).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('invalid x-api-key');
  });

  it('returns VISION_BAD_REQUEST on invalid frame input instead of generic error', async () => {
    configureVision();
    const response = await analyzeFrame(frameRequest({ frames: [] }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('VISION_BAD_REQUEST');
  });

  it('falls back across verified free OpenRouter models when primary free model fails', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    delete process.env.FRAMESCRIPT_VISION_API_KEY;

    const attemptedModels: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { model: string };
      attemptedModels.push(parsed.model);
      if (parsed.model === 'google/gemma-4-31b-it:free') {
        return new Response(
          JSON.stringify({ error: { message: 'Rate limited', code: 429 } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  actions: [
                    { offsetMs: 0, description: 'Sun rises', participants: [], confidence: 'high' },
                  ],
                  characters: [],
                  settingChanges: [],
                  text: [],
                  uncertainties: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(200);
    expect(attemptedModels[0]).toBe('google/gemma-4-31b-it:free');
    expect(attemptedModels[1]).toBe('google/gemma-4-26b-a4b-it:free');
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe('google/gemma-4-26b-a4b-it:free');
  });

  it('routes to openrouter/free requiring image parts and strictly validating schema', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL = 'openrouter/free';
    delete process.env.FRAMESCRIPT_VISION_API_KEY;

    let receivedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  actions: [
                    { offsetMs: 50, description: 'Character speaks', participants: [], confidence: 'high' },
                  ],
                  characters: [],
                  settingChanges: [],
                  text: [],
                  uncertainties: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(200);
    expect(receivedBody?.model).toBe('openrouter/free');

    // Invariant: Request MUST contain image_url parts
    const messages = receivedBody?.messages as { role: string; content: { type: string }[] }[];
    const userMsg = messages.find((m) => m.role === 'user');
    const imageParts = userMsg?.content.filter((p) => p.type === 'image_url');
    expect(imageParts?.length).toBeGreaterThan(0);

    const body = (await response.json()) as { model: string; analysis: { actions: unknown[] } };
    expect(body.model).toBe('openrouter/free');
    expect(body.analysis.actions).toHaveLength(1);
    delete process.env.FRAMESCRIPT_OPENROUTER_VISION_MODEL;
  });

  it('terminates fallback loop cleanly without infinite retry when all free fallbacks fail', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    delete process.env.FRAMESCRIPT_VISION_API_KEY;

    let callCount = 0;
    const attemptedModels: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const parsed = JSON.parse(String(init?.body)) as { model: string };
      attemptedModels.push(parsed.model);
      return new Response(
        JSON.stringify({ error: { message: 'Provider internal error', code: 500 } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(502);
    // 1 primary + 3 fallbacks = 4 total attempts, no infinite loop
    expect(callCount).toBe(4);
    expect(attemptedModels).toEqual([
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'qwen/qwen3.8-27b:free',
      'openrouter/free',
    ]);
  });
});

describe('POST /api/analyze-frame on Vercel production', () => {
  it('sends frames only to the pinned $0 Gateway model with its declared wire options', async () => {
    process.env.VERCEL = '1';
    process.env.AI_GATEWAY_API_KEY = SECRET;
    delete process.env.OPENROUTER_API_KEY;
    // A stale paid-capable override must not be used.
    configureVision();

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  actions: [],
                  characters: [],
                  settingChanges: [],
                  text: [],
                  uncertainties: ['A single flat frame shows no discernible content.'],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent.model).toBe('stealth/pixel-canary');
    expect(sent).not.toHaveProperty('response_format');
    expect(sent.reasoning).toEqual({ effort: 'none' });
    const body = (await response.json()) as { provider: string; model: string };
    expect(body).toMatchObject({ provider: 'vercel-ai-gateway', model: 'stealth/pixel-canary' });
  });

  it('returns the allowlisted Gateway reason when the model is withdrawn', async () => {
    process.env.VERCEL = '1';
    process.env.AI_GATEWAY_API_KEY = SECRET;
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Model stealth/pixel-canary not found', type: 'model_not_found' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const response = await analyzeFrame(frameRequest());
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      code: 'VISION_MODEL_UNAVAILABLE',
      reason: 'model_not_found',
    });
    expect(text).not.toContain('not found');
    expect(text).not.toContain(SECRET);
  });
});
