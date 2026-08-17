/**
 * Anthropic BYOK providers.
 *
 * Off unless the user enables remote AI and supplies their own key. The key is
 * stored in `chrome.storage.local` and is never bundled, logged, or sent
 * anywhere except the Anthropic API endpoint the user configured.
 *
 * What leaves the device when this is enabled is stated exactly in
 * `info.dataLeavingDevice` and repeated in Settings before the toggle turns on:
 * a handful of selected keyframes per analyzed window, the dialogue text for
 * that window, and sound-event labels. Never the audio, never the full video,
 * never the whole film.
 */

import type {
  ProviderAvailability,
  ScreenplayLanguageProvider,
  ScreenplayRenderRequest,
  TranslationProvider,
  TranslationRequest,
  VisionAnalysisProvider,
  VisionWindowAnalysis,
  VisionWindowRequest,
} from '../types';
import { extractJson } from '../validation';
import { buildVisionUserPrompt, validateVisionAnalysis, VISION_SYSTEM_PROMPT } from '../schemas/visionWindow';
import { FrameScriptError } from '../../utils/errors';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** Override for proxies; defaults to the public API. */
  baseUrl?: string;
  maxTokens?: number;
  /** Hard cap on frames per request, independent of what the caller passes. */
  maxFramesPerRequest?: number;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_MAX_FRAMES = 8;
const API_VERSION = '2023-06-01';

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  error?: { message?: string; type?: string };
}

async function callAnthropic(
  config: AnthropicConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(config.baseUrl ?? DEFAULT_BASE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': API_VERSION,
      // Required for browser-originated calls; the user's key, the user's call.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    // Deliberately does not include the response body: it can echo the request,
    // and request bodies contain frame data.
    throw new FrameScriptError({
      code: 'AI_PROVIDER_FAILED',
      detail: `Anthropic API returned ${response.status}`,
      recoverable: response.status === 429 || response.status >= 500,
    });
  }

  const json = (await response.json()) as AnthropicResponse;
  if (json.error) {
    throw new FrameScriptError({ code: 'AI_PROVIDER_FAILED', detail: json.error.type ?? 'api error' });
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
  if (!text) {
    throw new FrameScriptError({ code: 'AI_RESPONSE_INVALID', detail: 'empty response' });
  }
  return text;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class AnthropicVisionProvider implements VisionAnalysisProvider {
  #config: AnthropicConfig;

  readonly info = {
    id: 'anthropic-vision',
    label: 'Anthropic (your API key)',
    kind: 'remote' as const,
    dataLeavingDevice:
      'Up to 8 downscaled keyframes per analyzed window, the dialogue text in that window, and sound-event labels. No audio, and never the full video.',
  };

  constructor(config: AnthropicConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.#config.apiKey) return { available: false, reason: 'No API key configured.' };
    if (!this.#config.model) return { available: false, reason: 'No model selected.' };
    return { available: true };
  }

  async analyzeWindow(request: VisionWindowRequest): Promise<VisionWindowAnalysis | null> {
    const maxFrames = this.#config.maxFramesPerRequest ?? DEFAULT_MAX_FRAMES;
    const frames = request.frames.slice(0, maxFrames);
    if (frames.length === 0) return null;

    // Frames are interleaved with their offsets so ordering survives the wire.
    const content: Record<string, unknown>[] = [];
    for (const frame of frames) {
      content.push({ type: 'text', text: `Frame at +${frame.timestamp - request.start}ms:` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: frame.mimeType, data: toBase64(frame.data) },
      });
    }
    content.push({ type: 'text', text: buildVisionUserPrompt({ ...request, frames }) });

    const text = await callAnthropic(
      this.#config,
      {
        model: this.#config.model,
        max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: VISION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      request.signal,
    );

    const parsed = extractJson(text);
    if (parsed === undefined) {
      throw new FrameScriptError({ code: 'AI_RESPONSE_INVALID', detail: 'response was not JSON' });
    }
    const validated = validateVisionAnalysis(parsed);
    if (!validated) {
      // Discard rather than salvage: a half-understood scene description is
      // worse than none, because it would carry full provenance weight.
      throw new FrameScriptError({ code: 'AI_RESPONSE_INVALID', detail: 'schema validation failed' });
    }
    return validated;
  }
}

const TRANSLATION_SYSTEM_PROMPT = `You translate screenplay dialogue and action lines.

Rules:
- Translate meaning and register faithfully. Do not add, remove, or explain.
- Preserve the line count exactly: return one translation per input line, in order.
- Keep proper nouns as-is unless the target language has a standard rendering.
- Do not add honorifics, speaker names, or stage directions that are not in the source.
- Respond with a JSON array of strings and nothing else.`;

export class AnthropicTranslationProvider implements TranslationProvider {
  #config: AnthropicConfig;

  readonly info = {
    id: 'anthropic-translation',
    label: 'Anthropic translation (your API key)',
    kind: 'remote' as const,
    dataLeavingDevice: 'Only the text lines being translated.',
  };

  constructor(config: AnthropicConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    return this.#config.apiKey
      ? { available: true }
      : { available: false, reason: 'No API key configured.' };
  }

  async translate(request: TranslationRequest): Promise<string[] | null> {
    if (request.texts.length === 0) return [];

    const prompt = [
      `Target language: ${request.targetLanguage}`,
      request.sourceLanguage ? `Source language: ${request.sourceLanguage}` : null,
      request.context ? `Scene context (do not translate): ${request.context}` : null,
      'Lines:',
      JSON.stringify(request.texts),
    ]
      .filter(Boolean)
      .join('\n');

    const text = await callAnthropic(
      this.#config,
      {
        model: this.#config.model,
        max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: TRANSLATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      request.signal,
    );

    const parsed = extractJsonArray(text);
    // A length mismatch means alignment is broken; better to drop the batch
    // than to silently pair line 3 with line 4's translation.
    if (!parsed || parsed.length !== request.texts.length) {
      throw new FrameScriptError({
        code: 'AI_RESPONSE_INVALID',
        detail: `expected ${request.texts.length} translations, got ${parsed?.length ?? 'none'}`,
      });
    }
    return parsed;
  }
}

const SCREENPLAY_SYSTEM_PROMPT = `You phrase screenplay action lines in a target language.

You receive structured beats that were derived from observed evidence. Your only job is wording.

Rules:
- Never add facts, characters, motives, or events that are not in the input.
- Never remove a beat. Return exactly one line per input beat, in order.
- Screenplay convention: present tense, third person, concise, no camera directions.
- Respond with a JSON array of strings and nothing else.`;

export class AnthropicScreenplayLanguageProvider implements ScreenplayLanguageProvider {
  #config: AnthropicConfig;

  readonly info = {
    id: 'anthropic-screenplay',
    label: 'Anthropic screenplay phrasing (your API key)',
    kind: 'remote' as const,
    dataLeavingDevice: 'Only the already-derived action and sound descriptions being phrased.',
  };

  constructor(config: AnthropicConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    return this.#config.apiKey
      ? { available: true }
      : { available: false, reason: 'No API key configured.' };
  }

  async render(request: ScreenplayRenderRequest): Promise<string[] | null> {
    if (request.beats.length === 0) return [];

    const prompt = [
      `Target language: ${request.targetLanguage}`,
      request.sceneHeading ? `Scene: ${request.sceneHeading}` : null,
      'Beats:',
      JSON.stringify(request.beats.map((b) => ({ kind: b.kind, text: b.text }))),
    ]
      .filter(Boolean)
      .join('\n');

    const text = await callAnthropic(
      this.#config,
      {
        model: this.#config.model,
        max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: SCREENPLAY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      request.signal,
    );

    const parsed = extractJsonArray(text);
    if (!parsed || parsed.length !== request.beats.length) {
      throw new FrameScriptError({
        code: 'AI_RESPONSE_INVALID',
        detail: `expected ${request.beats.length} lines, got ${parsed?.length ?? 'none'}`,
      });
    }
    return parsed;
  }
}

function extractJsonArray(text: string): string[] | null {
  const direct = extractJson(text);
  if (Array.isArray(direct) && direct.every((x) => typeof x === 'string')) return direct as string[];

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
    } catch {
      return null;
    }
  }
  return null;
}
