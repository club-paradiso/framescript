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
import {
  isError,
  readVisionConfig,
  LIMITS,
  VERIFIED_FREE_OPENROUTER_VISION_MODELS,
  isFreeOpenRouterModel,
} from './_lib/config.js';
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
import { FrameScriptError } from '../src/utils/errors.js';
import { isAbort } from '../src/ai/retry.js';
import type {
  ContactSheetLayout,
  VisionAnalysisProvider,
  VisionFrame,
  VisionWindowRequest,
} from '../src/ai/types.js';

export const config = { maxDuration: 60 };

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_TEXT = 400;

interface FramePayload {
  timestamp?: unknown;
  data?: unknown;
  mimeType?: unknown;
  width?: unknown;
  height?: unknown;
  sheet?: unknown;
}

/** A sheet is a bounded grid; more tiles would only shrink each one. */
const MAX_SHEET_TILES = 30;

interface RequestPayload {
  start?: unknown;
  end?: unknown;
  frames?: unknown;
  dialogue?: unknown;
  soundEvents?: unknown;
  currentSetting?: unknown;
  knownCharacters?: unknown;
  recentActions?: unknown;
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
    return badRequest('Expected a JSON body.', 'VISION_BAD_REQUEST');
  }

  const start = finiteNumber(payload.start);
  const end = finiteNumber(payload.end);
  if (start === null || end === null || end <= start) {
    return badRequest('Invalid window range.', 'VISION_BAD_REQUEST');
  }

  const framesResult = parseFrames(payload.frames, start, end);
  if ('error' in framesResult) return badRequest(framesResult.error, 'VISION_BAD_REQUEST');
  if (framesResult.frames.length === 0) {
    return badRequest('At least one frame is required.', 'VISION_BAD_REQUEST');
  }

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
          ...(vision.requestOptions ? { requestOptions: vision.requestOptions } : {}),
        });

  const windowRequest: VisionWindowRequest = {
    start,
    end,
    frames: framesResult.frames,
    dialogue: parseDialogue(payload.dialogue, start, end),
    soundEvents: parseSounds(payload.soundEvents, start, end),
    knownCharacters: parseCharacters(payload.knownCharacters),
    ...(parseRecentActions(payload.recentActions) ?? {}),
    ...(typeof payload.currentSetting === 'string' && payload.currentSetting
      ? { currentSetting: payload.currentSetting.slice(0, MAX_TEXT) }
      : {}),
    ...(payload.requestOcr === true ? { requestOcr: true } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };

  try {
    let analysis;
    let effectiveModel = vision.model;
    try {
      analysis = await provider.analyzeWindow(windowRequest);
    } catch (primaryError) {
      const isAccountGate =
        FrameScriptError.is(primaryError) &&
        (primaryError.reason === 'payment_required' ||
          primaryError.reason === 'insufficient_funds' ||
          primaryError.reason === 'customer_verification_required');
      const isOpenRouterFree =
        vision.provider === 'openai-compatible' && isFreeOpenRouterModel(vision.model);

      if (isOpenRouterFree && !isAccountGate && !isAbort(primaryError)) {
        const fallbacks = VERIFIED_FREE_OPENROUTER_VISION_MODELS.filter(
          (m) => m !== vision.model,
        );
        let fallbackSucceeded = false;
        for (const fallbackModel of fallbacks) {
          if (request.signal?.aborted) break;
          console.warn(
            `[framescript-api] Primary free vision model ${vision.model} failed, attempting verified free fallback ${fallbackModel}`,
          );
          try {
            const fallbackProvider = new OpenAiCompatibleVisionProvider({
              apiKey: vision.apiKey,
              endpoint: vision.endpoint,
              model: fallbackModel,
              maxFramesPerRequest: LIMITS.maxFramesPerRequest,
              ...(vision.requestOptions ? { requestOptions: vision.requestOptions } : {}),
            });
            analysis = await fallbackProvider.analyzeWindow(windowRequest);
            effectiveModel = fallbackModel;
            fallbackSucceeded = true;
            break;
          } catch (fallbackError) {
            console.warn(
              `[framescript-api] Free vision fallback ${fallbackModel} failed:`,
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            );
          }
        }
        if (!fallbackSucceeded) throw primaryError;
      } else {
        throw primaryError;
      }
    }

    if (!analysis) return json({ start, end, analysis: null });
    return json({ start, end, analysis, provider: vision.provider, model: effectiveModel });
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
    const sheet = parseSheet(raw.sheet, start, end);
    if (sheet && 'error' in sheet) return { error: sheet.error };
    frames.push({ timestamp, data, mimeType, width, height, ...(sheet ? { sheet } : {}) });
  }
  frames.sort((a, b) => a.timestamp - b.timestamp);
  return { frames };
}

function parseSheet(
  value: unknown,
  start: number,
  end: number,
): ContactSheetLayout | { error: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value as { columns?: unknown; rows?: unknown; tileTimestamps?: unknown };
  const columns = finiteNumber(raw.columns);
  const rows = finiteNumber(raw.rows);
  if (
    columns === null ||
    rows === null ||
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns * rows > MAX_SHEET_TILES
  ) {
    return { error: 'Contact sheet layout is out of range.' };
  }
  if (!Array.isArray(raw.tileTimestamps) || raw.tileTimestamps.length === 0) {
    return { error: 'Contact sheet tiles are missing.' };
  }
  if (raw.tileTimestamps.length > columns * rows) {
    return { error: 'Contact sheet has more tiles than its grid.' };
  }
  const tileTimestamps: number[] = [];
  for (const entry of raw.tileTimestamps) {
    const t = finiteNumber(entry);
    if (t === null || t < start || t > end) {
      return { error: 'Contact sheet tile falls outside the window.' };
    }
    if (tileTimestamps.length > 0 && t < tileTimestamps[tileTimestamps.length - 1]!) {
      return { error: 'Contact sheet tiles must be in time order.' };
    }
    tileTimestamps.push(t);
  }
  return { columns, rows, tileTimestamps };
}

/** Labels the client carried over from earlier windows. Text only, bounded. */
function parseCharacters(value: unknown): VisionWindowRequest['knownCharacters'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: VisionWindowRequest['knownCharacters'] = [];
  for (const entry of value.slice(0, 12)) {
    const raw = entry as { id?: unknown; displayName?: unknown };
    const label = typeof raw.displayName === 'string' ? raw.displayName : raw.id;
    if (typeof label !== 'string') continue;
    const clean = label.trim().slice(0, 64);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push({ id: clean, displayName: clean });
  }
  return result;
}

function parseRecentActions(value: unknown): { recentActions: string[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  const recentActions = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(-4)
    .map((entry) => entry.trim().slice(0, 200));
  return recentActions.length > 0 ? { recentActions } : undefined;
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
