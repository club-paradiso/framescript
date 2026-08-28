/**
 * OpenAI-compatible multimodal vision provider.
 *
 * A narrow adapter, not a second vision system: the system prompt, the user
 * prompt, the response schema and the validator are all the ones the Anthropic
 * provider uses. Only the wire format differs — `/chat/completions` with
 * `image_url` data URIs instead of Anthropic's `messages` blocks.
 *
 * It exists so that "vision" is not synonymous with one vendor, which matters
 * for a self-hosted or gateway deployment.
 */

import type {
  ProviderAvailability,
  VisionAnalysisProvider,
  VisionWindowAnalysis,
  VisionWindowRequest,
} from '../types';
import { extractJson } from '../validation';
import {
  VISION_SYSTEM_PROMPT,
  buildVisionUserPrompt,
  validateVisionAnalysis,
} from '../schemas/visionWindow';
import { FrameScriptError } from '../../utils/errors';
import { providerError } from '../retry';
import { toBase64 } from '../../utils/base64';

export interface OpenAiCompatibleVisionConfig {
  apiKey: string;
  /** Full endpoint URL, e.g. https://api.openai.com/v1/chat/completions */
  endpoint: string;
  model: string;
  maxTokens?: number;
  maxFramesPerRequest?: number;
}

const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_MAX_FRAMES = 8;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; type?: string };
}

export class OpenAiCompatibleVisionProvider implements VisionAnalysisProvider {
  #config: OpenAiCompatibleVisionConfig;

  readonly info = {
    id: 'openai-compatible-vision',
    label: 'Multimodal chat endpoint (your API key)',
    kind: 'remote' as const,
    dataLeavingDevice:
      'Up to 8 downscaled keyframes per analyzed window, the dialogue text in that window, and sound-event labels. No audio, and never the full video.',
  };

  constructor(config: OpenAiCompatibleVisionConfig) {
    this.#config = config;
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.#config.apiKey) return { available: false, reason: 'No API key configured.' };
    if (!this.#config.endpoint) return { available: false, reason: 'No endpoint configured.' };
    if (!this.#config.model) return { available: false, reason: 'No model selected.' };
    return { available: true };
  }

  async analyzeWindow(request: VisionWindowRequest): Promise<VisionWindowAnalysis | null> {
    const maxFrames = this.#config.maxFramesPerRequest ?? DEFAULT_MAX_FRAMES;
    const frames = request.frames.slice(0, maxFrames);
    if (frames.length === 0) return null;

    const content: Record<string, unknown>[] = [];
    for (const frame of frames) {
      content.push({ type: 'text', text: `Frame at +${frame.timestamp - request.start}ms:` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:${frame.mimeType};base64,${toBase64(frame.data)}` },
      });
    }
    content.push({ type: 'text', text: buildVisionUserPrompt({ ...request, frames }) });

    const response = await fetch(this.#config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.#config.model,
        max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      // The body can echo the request, and the request contains frames.
      throw providerError(response.status, 'vision', `vision endpoint returned ${response.status}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    if (json.error) {
      throw new FrameScriptError({
        code: 'VISION_PROVIDER_FAILED',
        detail: json.error.type ?? 'api error',
      });
    }
    const text = json.choices?.[0]?.message?.content;
    if (!text) {
      throw new FrameScriptError({ code: 'AI_RESPONSE_INVALID', detail: 'empty response' });
    }

    const parsed = extractJson(text);
    if (parsed === undefined) {
      throw new FrameScriptError({ code: 'AI_RESPONSE_INVALID', detail: 'response was not JSON' });
    }
    const validated = validateVisionAnalysis(parsed);
    if (!validated) {
      throw new FrameScriptError({
        code: 'AI_RESPONSE_INVALID',
        detail: 'schema validation failed',
      });
    }
    return validated;
  }
}
