/** Temporary preview-only provider probe. Remove before merge. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readAsrConfig, readVisionConfig, isError } from './_lib/config.js';
import { json, methodNotAllowed } from './_lib/http.js';
import { writeWebResponse } from './_lib/nodeAdapter.js';
import { encodeWav } from '../src/audio/dsp.js';
import { toBase64 } from '../src/utils/base64.js';

export const config = { maxDuration: 60 };

function safeProviderError(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  const rawError = body.error;
  if (!rawError || typeof rawError !== 'object') return undefined;
  const error = rawError as Record<string, unknown>;
  return {
    ...(typeof error.code === 'string' ? { code: error.code.slice(0, 120) } : {}),
    ...(typeof error.type === 'string' ? { type: error.type.slice(0, 120) } : {}),
    ...(typeof error.param === 'string' ? { param: error.param.slice(0, 120) } : {}),
    ...(typeof error.message === 'string' ? { message: error.message.slice(0, 500) } : {}),
  };
}

async function inspect(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    ok: response.ok,
    requestId:
      response.headers.get('x-request-id') ??
      response.headers.get('x-vercel-id') ??
      response.headers.get('request-id') ??
      undefined,
    error: safeProviderError(body),
    ...(response.ok && body && typeof body === 'object'
      ? { shape: Object.keys(body as Record<string, unknown>).slice(0, 20) }
      : {}),
  };
}

function syntheticWav(): Uint8Array {
  const sampleRate = 16_000;
  const seconds = 2;
  const samples = new Float32Array(sampleRate * seconds);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.05;
  }
  return encodeWav(samples, sampleRate);
}

async function probeAsr(): Promise<Record<string, unknown>> {
  const asr = readAsrConfig();
  if (isError(asr)) return { configured: false, error: asr.error };
  const wav = syntheticWav();
  const response = await fetch(asr.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${asr.apiKey}`,
      'content-type': 'application/json',
      'ai-model-id': asr.model,
    },
    body: JSON.stringify({ audio: toBase64(wav), mediaType: 'audio/wav' }),
  });
  return {
    configured: true,
    provider: asr.provider,
    model: asr.model,
    wavBytes: wav.byteLength,
    ...(await inspect(response)),
  };
}

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function probeVisionModel(
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with one word describing this image.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } },
          ],
        },
      ],
    }),
  });
  return { model, ...(await inspect(response)) };
}

async function probeVision(): Promise<Record<string, unknown>> {
  const vision = readVisionConfig();
  if (isError(vision)) return { configured: false, error: vision.error };
  const models = Array.from(
    new Set([vision.model, 'openai/gpt-4.1-mini', 'google/gemini-3.5-flash-lite']),
  );
  const results = [];
  for (const model of models) {
    results.push(await probeVisionModel(vision.endpoint, vision.apiKey, model));
  }
  return { configured: true, provider: vision.provider, endpointKind: 'chat-completions', results };
}

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV === 'production') {
    return json({ error: 'debug endpoint disabled in production' }, 404);
  }
  const [asr, vision] = await Promise.all([probeAsr(), probeVision()]);
  return json({ asr, vision });
}

export default async function handler(
  request: Request | IncomingMessage,
  response?: ServerResponse,
): Promise<Response | void> {
  if (request instanceof Request) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return GET();
  }
  if (!response) throw new TypeError('Vercel Node response is required.');
  if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
    await writeWebResponse(response, methodNotAllowed('GET'));
    return;
  }
  await writeWebResponse(response, await GET());
}
