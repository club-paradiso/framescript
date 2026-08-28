#!/usr/bin/env node
/**
 * Production AI smoke test.
 *
 * This deliberately uses only repository-generated/synthetic media. It sends
 * one bounded WAV fixture and one 1x1 PNG through FrameScript's public
 * production endpoints and verifies the complete server -> Vercel AI Gateway
 * -> provider -> FrameScript response path. No user media or credentials are
 * involved, and response content is never printed.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = (process.env.FRAMESCRIPT_SMOKE_ORIGIN || 'https://framescript-eta.vercel.app').replace(
  /\/$/,
  '',
);
const expectedAsrModel = process.env.FRAMESCRIPT_SMOKE_ASR_MODEL || 'openai/gpt-4o-transcribe';
const expectedVisionModel =
  process.env.FRAMESCRIPT_SMOKE_VISION_MODEL || 'google/gemini-3.5-flash-lite';
const expectedGitSha = process.env.FRAMESCRIPT_SMOKE_GIT_SHA || '';
const expectedEnvironment = process.env.FRAMESCRIPT_SMOKE_ENVIRONMENT || '';

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
    fail(`${label} returned HTTP ${response.status} code=${code}`);
  }
  return body;
}

async function checkCapabilities() {
  const response = await fetch(`${origin}/api/capabilities`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await jsonResponse(response, 'capabilities');

  if (body?.transcription?.configured !== true) fail('transcription is not configured');
  if (body?.vision?.configured !== true) fail('vision is not configured');
  if (body.transcription.provider !== 'vercel-ai-gateway') {
    fail(`unexpected ASR provider ${String(body.transcription.provider)}`);
  }
  if (body.vision.provider !== 'vercel-ai-gateway') {
    fail(`unexpected vision provider ${String(body.vision.provider)}`);
  }
  if (body.transcription.model !== expectedAsrModel) {
    fail(`unexpected ASR model ${String(body.transcription.model)}`);
  }
  if (body.vision.model !== expectedVisionModel) {
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
    `[production-ai-smoke] capabilities OK: ASR=${body.transcription.model} vision=${body.vision.model}${identity}`,
  );
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

await checkCapabilities();
await checkTranscription();
await checkVision();
console.log('[production-ai-smoke] all production AI inference checks passed');
