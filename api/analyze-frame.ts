/**
 * POST /api/analyze-frame
 *
 * Semantic evidence for one *window* of picture — never the film, never a frame
 * stream. The browser's temporal scanner picks a handful of keyframes around a
 * scene cut or a sustained action, downscales them, and sends only those.
 *
 * The provider is asked for observations, not prose: what is visible, what
 * moved, what setting is implied, what text is on screen, and what it could not
 * determine. The response is schema-validated by the same validator the
 * extension uses, and anything that fails validation is discarded rather than
 * salvaged. The screenplay is still written by the deterministic engine from
 * the evidence this produces.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isError, readVisionConfig, LIMITS } from './_lib/config.js';
import {
  badRequest,
  declaredTooLarge,
  errorResponse,
  json,
  methodNotAllowed,
  tooLarge,
} from './_lib/http.js';
import { toWebRequest, writeWebResponse } from './_lib/nodeAdapter.js';
import { AnthropicVisionProvider } from '../src/ai/providers/anthropic.js';
import { OpenAiCompatibleVisionProvider } from '../src/ai/providers/openaiCompatibleVision.js';
import { fromBase64 } from '../src/utils/base64.js';
import type { VisionAnalysisProvider, VisionFrame, VisionWindowRequest } from '../src/ai/types.js';

export const config = { maxDuration: 60 };

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_TEXT = 400;

interface FramePayload {
  timestamp?: unknown;
  data?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
}

interface RequestPayload {
  start?: unknown;
  end?: unknown;
  frames?: unknown;
  dialogue?: unknown;
  soundEvents?: unknown;
  currentSetting?: unknown;
  requestOcr?: unknown;
  metrics?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  if (declaredTooLarge(request))
    return tooLarge('Frame payload is larger than this endpoint accepts.');

  const vision = readVisionConfig();
  if (isError(vision)) return json({ code: 'VISION_NOT_CONFIGURED', message: vision.error }, 503);

  let payload: RequestPayload;
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return badRequest('Expected a JSON body.');
  }

  const start = finiteNumber(payload.start);
  const end = finiteNumber(payload.end);
  if (start === null || end === null || end <= start) return badRequest('Invalid window range.');

  const framesResult = parseFrames(payload.frames, start, end);
  if ('error' in framesResult) return badRequest(framesResult.error);
  if (framesResult.frames.length === 0) return badRequest('At least one frame is required.');

  const provider: VisionAnalysisProvider =
    vision.provider === 'anthropic'
      ? new AnthropicVisionProvider({
          apiKey: vision.apiKey,
          model: vision.model,
          baseUrl: vision.endpoint,
          maxFramesPerRequest: LIMITS.maxFramesPerRequest,
        })
      : new OpenAiCompatibleVisionProvider({
          apiKey: vision.apiKey,
          endpoint: vision.endpoint,
          model: vision.model,
          maxFramesPerRequest: LIMITS.maxFramesPerRequest,
        });

  const windowRequest: VisionWindowRequest = {
    start,
    end,
    frames: framesResult.frames,
    dialogue: parseDialogue(payload.dialogue, start, end),
    soundEvents: parseSounds(payload.soundEvents, start, end),
    knownCharacters: [],
    ...(typeof payload.currentSetting === 'string' && payload.currentSetting
      ? { currentSetting: payload.currentSetting.slice(0, MAX_TEXT) }
      : {}),
    ...(payload.requestOcr === true ? { requestOcr: true } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };

  try {
    const analysis = await provider.analyzeWindow(windowRequest);
    if (!analysis) return json({ start, end, analysis: null });
    return json({ start, end, analysis, provider: vision.provider, model: vision.model });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Direct tests use Web Request; Vercel uses legacy Node req/res. */
export default function handler(request: Request): Promise<Response>;
export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
export default async function handler(
  request: Request | IncomingMessage,
  response?: ServerResponse,
): Promise<Response | void> {
  if (request instanceof Request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return POST(request);
  }
  if (!response) throw new TypeError('Vercel Node response is required.');

  if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
    await writeWebResponse(response, methodNotAllowed('POST'));
    return;
  }

  const webRequest = await toWebRequest(request);
  const result = await POST(webRequest);
  await writeWebResponse(response, result);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseFrames(
  value: unknown,
  start: number,
  end: number,
): { frames: VisionFrame[] } | { error: string } {
  if (!Array.isArray(value)) return { error: '"frames" must be an array.' };
  if (value.length > LIMITS.maxFramesPerRequest) {
    return { error: `At most ${LIMITS.maxFramesPerRequest} frames per request.` };
  }

  const frames: VisionFrame[] = [];
  for (const raw of value as FramePayload[]) {
    const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : '';
    if (!ALLOWED_IMAGE_TYPES.has(mimeType))
      return { error: `Unsupported frame type "${mimeType}".` };
    if (typeof raw.data !== 'string' || raw.data.length === 0)
      return { error: 'Frame data missing.' };
    if ((raw.data.length * 3) / 4 > LIMITS.maxFrameBytes)
      return { error: 'Frame exceeds the size limit.' };

    let data: Uint8Array;
    try {
      data = fromBase64(raw.data);
    } catch {
      return { error: 'Frame data is not valid base64.' };
    }
    if (data.byteLength > LIMITS.maxFrameBytes) return { error: 'Frame exceeds the size limit.' };

    const timestamp = finiteNumber(raw.timestamp);
    if (timestamp === null || timestamp < start || timestamp > end) {
      return { error: 'Frame timestamp falls outside the window.' };
    }
    const width = finiteNumber(raw.width) ?? 0;
    const height = finiteNumber(raw.height) ?? 0;
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
      return { error: 'Frame dimensions are out of range.' };
    }
    frames.push({ timestamp, data, mimeType, width, height });
  }
  frames.sort((a, b) => a.timestamp - b.timestamp);
  return { frames };
}

function parseDialogue(value: unknown, start: number, end: number) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 24)
    .map((entry) => entry as { start?: unknown; speakerId?: unknown; text?: unknown })
    .filter((entry) => typeof entry.text === 'string' && entry.text.trim().length > 0)
    .map((entry) => ({
      start: clampTime(finiteNumber(entry.start) ?? start, start, end),
      ...(typeof entry.speakerId === 'string' ? { speakerId: entry.speakerId.slice(0, 64) } : {}),
      text: (entry.text as string).slice(0, MAX_TEXT),
    }));
}

function parseSounds(value: unknown, start: number, end: number) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 24)
    .map((entry) => entry as { start?: unknown; kind?: unknown; description?: unknown })
    .filter((entry) => typeof entry.kind === 'string')
    .map((entry) => ({
      start: clampTime(finiteNumber(entry.start) ?? start, start, end),
      kind: entry.kind as VisionWindowRequest['soundEvents'][number]['kind'],
      ...(typeof entry.description === 'string'
        ? { description: entry.description.slice(0, 120) }
        : {}),
    }));
}

function clampTime(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
