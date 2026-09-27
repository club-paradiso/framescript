#!/usr/bin/env node
/**
 * Production AI smoke test.
 *
 * This deliberately uses only repository-generated/synthetic media. It sends
 * one bounded WAV fixture and one 1x1 PNG through FrameScript's public
 * production endpoints and verifies the complete server -> provider ->
 * FrameScript response path. No user media or credentials are involved, and
 * response content is never printed.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = (process.env.FRAMESCRIPT_SMOKE_ORIGIN || 'https://framescript-eta.vercel.app').replace(
  /\/$/,
  '',
);
const expectedGitSha = process.env.FRAMESCRIPT_SMOKE_GIT_SHA || '';
const expectedEnvironment = process.env.FRAMESCRIPT_SMOKE_ENVIRONMENT || '';

function parseAllowlist(value, fallback) {
  return new Set(
    (value || fallback)
      .split(',')
      .map((provider) => provider.trim())
      .filter(Boolean),
  );
}

const allowedAsrProviders = parseAllowlist(
  process.env.FRAMESCRIPT_SMOKE_ASR_PROVIDERS,
  'vercel-ai-gateway',
);
const allowedVisionProviders = parseAllowlist(
  process.env.FRAMESCRIPT_SMOKE_VISION_PROVIDERS,
  'vercel-ai-gateway',
);
const allowedAsrModels = parseAllowlist(
  process.env.FRAMESCRIPT_SMOKE_ASR_MODELS,
  'openai/gpt-4o-transcribe',
);
const allowedVisionModels = parseAllowlist(
  process.env.FRAMESCRIPT_SMOKE_VISION_MODELS,
  'stealth/pixel-canary',
);

/** Public, unauthenticated model catalogs used to prove vision is $0. */
const GATEWAY_CATALOG = 'https://ai-gateway.vercel.sh/v1/models';
const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1/models';
/** FrameScript API error `reason` is a closed enum; anything else is dropped. */
const SAFE_REASON = /^[a-z_]{1,64}$/;

const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function fail(message) {
  throw new Error(`[production-ai-smoke] ${message}`);
}

async function jsonResponse(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`${label} returned ${response.status} with a non-JSON body`);
  }
  if (!response.ok) {
    const code = body && typeof body.code === 'string' ? body.code : 'unknown';
    const reason =
      body && typeof body.reason === 'string' && SAFE_REASON.test(body.reason)
        ? ` reason=${body.reason}`
        : '';
    fail(`${label} returned HTTP ${response.status} code=${code}${reason}`);
  }
  return body;
}

/** True when every numeric price anywhere in `pricing` is exactly zero. */
function allPricesZero(pricing) {
  if (pricing === null || pricing === undefined) return false;
  let sawPrice = false;
  const visit = (value) => {
    if (Array.isArray(value)) return value.every(visit);
    if (value && typeof value === 'object') return Object.values(value).every(visit);
    if (typeof value === 'boolean') return true;
    const number = Number(value);
    if (!Number.isFinite(number)) return true;
    sawPrice = true;
    return number === 0;
  };
  return visit(pricing) && sawPrice;
}

async function publicJson(url, label) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) fail(`${label} catalog returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail(`${label} catalog returned a non-JSON body`);
  }
}

/**
 * Production vision must be $0. A pinned slug can be repriced or withdrawn
 * upstream after it was chosen, so this proves the price against the live
 * public catalog before any frame is sent. For Gateway it checks every serving
 * endpoint, so a paid provider behind the same model id also fails the smoke.
 */
async function checkVisionZeroCost(provider, model) {
  if (provider === 'vercel-ai-gateway') {
    const body = await publicJson(
      `${GATEWAY_CATALOG}/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`,
      'Gateway',
    );
    const endpoints = body?.data?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      fail(`vision model ${model} has no serving endpoints in the Gateway catalog`);
    }
    if (!endpoints.every((endpoint) => allPricesZero(endpoint?.pricing))) {
      fail(`vision model ${model} has a non-zero price in the Gateway catalog`);
    }
    console.log(
      `[production-ai-smoke] vision cost OK: ${model} is $0 on all ${endpoints.length} Gateway endpoint(s)`,
    );
    return;
  }
  if (provider === 'openai-compatible') {
    const body = await publicJson(OPENROUTER_CATALOG, 'OpenRouter');
    const entry = Array.isArray(body?.data) ? body.data.find((m) => m?.id === model) : undefined;
    if (!entry) fail(`vision model ${model} is not listed in the OpenRouter catalog`);
    if (!allPricesZero(entry.pricing)) {
      fail(`vision model ${model} has a non-zero price in the OpenRouter catalog`);
    }
    console.log(`[production-ai-smoke] vision cost OK: ${model} is $0 in the OpenRouter catalog`);
    return;
  }
  fail(`cannot prove vision cost for provider ${String(provider)}`);
}

async function checkCapabilities() {
  const response = await fetch(`${origin}/api/capabilities`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await jsonResponse(response, 'capabilities');

  if (body?.transcription?.configured !== true) fail('transcription is not configured');
  if (body?.vision?.configured !== true) fail('vision is not configured');

  if (!allowedAsrProviders.has(body.transcription.provider)) {
    fail(`unexpected ASR provider ${String(body.transcription.provider)}`);
  }
  if (!allowedVisionProviders.has(body.vision.provider)) {
    fail(`unexpected vision provider ${String(body.vision.provider)}`);
  }
  if (!allowedAsrModels.has(body.transcription.model)) {
    fail(`unexpected ASR model ${String(body.transcription.model)}`);
  }
  if (!allowedVisionModels.has(body.vision.model)) {
    fail(`unexpected vision model ${String(body.vision.model)}`);
  }
  if (expectedGitSha && body?.deployment?.commitSha !== expectedGitSha) {
    fail(
      `deployment SHA mismatch expected=${expectedGitSha} actual=${String(body?.deployment?.commitSha)}`,
    );
  }
  if (expectedEnvironment && body?.deployment?.environment !== expectedEnvironment) {
    fail(
      `deployment environment mismatch expected=${expectedEnvironment} actual=${String(body?.deployment?.environment)}`,
    );
  }

  const identity = body?.deployment?.commitSha
    ? ` sha=${body.deployment.commitSha.slice(0, 12)} env=${String(body.deployment.environment)}`
    : '';
  console.log(
    `[production-ai-smoke] capabilities OK: ASR=${body.transcription.provider}/${body.transcription.model} vision=${body.vision.provider}/${body.vision.model}${identity}`,
  );
  return body;
}

async function checkTranscription() {
  const wavPath = resolve('tests/fixtures/fixture-speech.wav');
  const wav = await readFile(wavPath);
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'fixture-speech.wav');
  form.append('startMs', '0');
  form.append('endMs', '14000');
  form.append('language', 'en');

  const response = await fetch(`${origin}/api/transcribe`, {
    method: 'POST',
    body: form,
  });
  const body = await jsonResponse(response, 'transcription');

  if (typeof body?.text !== 'string') fail('transcription response is missing text');
  if (!Array.isArray(body?.segments)) fail('transcription response is missing segments');

  // Never print the transcript. This fixture is synthetic today, but keeping
  // logs content-free makes the safety property survive future fixture changes.
  console.log(
    `[production-ai-smoke] transcription OK: HTTP ${response.status}, textLength=${body.text.length}, segments=${body.segments.length}`,
  );
}

async function checkVision() {
  const response = await fetch(`${origin}/api/analyze-frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      start: 0,
      end: 1000,
      frames: [
        {
          timestamp: 500,
          data: PIXEL_PNG,
          mimeType: 'image/png',
          width: 1,
          height: 1,
        },
      ],
      dialogue: [],
      soundEvents: [],
    }),
  });
  const body = await jsonResponse(response, 'vision');

  if (!('analysis' in (body ?? {}))) fail('vision response is missing analysis');
  const analysisKind = body.analysis === null ? 'null' : typeof body.analysis;
  console.log(`[production-ai-smoke] vision OK: HTTP ${response.status}, analysis=${analysisKind}`);
}

function safeFailure(error) {
  if (!(error instanceof Error)) return 'unknown failure';
  // Smoke errors are constructed only from HTTP status and FrameScript error
  // code. Do not append arbitrary response bodies or provider payloads here.
  return error.message.replace(/^\[production-ai-smoke\]\s*/, '');
}

const capabilities = await checkCapabilities();
await checkVisionZeroCost(capabilities.vision.provider, capabilities.vision.model);

const failures = [];
for (const [label, check] of [
  ['transcription', checkTranscription],
  ['vision', checkVision],
]) {
  try {
    await check();
  } catch (error) {
    const message = safeFailure(error);
    failures.push(`${label}: ${message}`);
    console.error(`[production-ai-smoke] ${label} FAILED: ${message}`);
  }
}

if (failures.length > 0) {
  fail(`${failures.length} live inference check(s) failed: ${failures.join('; ')}`);
}

console.log('[production-ai-smoke] all production AI inference checks passed');
