/**
 * Server-side AI configuration.
 *
 * Provider credentials live in environment variables on the server and are read
 * only here. Nothing in this file is imported by the client bundle, no value
 * read here is ever returned in a response, and the capability report
 * deliberately exposes only booleans and non-secret identifiers.
 *
 * A missing configuration is a *state*, not a crash: Studio shows
 * "Transcription — not configured" and keeps doing local analysis.
 */

export type AsrProviderId = 'openai-compatible' | 'vercel-ai-gateway';
export type VisionProviderId = 'anthropic' | 'openai-compatible';

export interface AsrConfig {
  provider: AsrProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface VisionConfig {
  provider: VisionProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
}

/** What the browser is allowed to know. Never contains a key or a full URL. */
export interface CapabilityReport {
  transcription: { configured: boolean; provider?: string; model?: string; reason?: string };
  vision: { configured: boolean; provider?: string; model?: string; reason?: string };
  limits: {
    maxAudioBytes: number;
    maxWindowMs: number;
    maxFramesPerRequest: number;
    maxFrameBytes: number;
  };
}

export const LIMITS = {
  /** One 30 s window of 16 kHz mono 16-bit PCM is ~960 KB; 4 MB is generous. */
  maxAudioBytes: 4 * 1024 * 1024,
  maxWindowMs: 30_000,
  maxFramesPerRequest: 8,
  maxFrameBytes: 512 * 1024,
  maxRequestBytes: 6 * 1024 * 1024,
} as const;

const DEFAULT_ASR_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_GATEWAY_ASR_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai/transcription-model';
const DEFAULT_GATEWAY_ASR_MODEL = 'openai/gpt-4o-transcribe';
const DEFAULT_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function readAsrConfig(): AsrConfig | { error: string } {
  const explicitApiKey = env('FRAMESCRIPT_ASR_API_KEY');
  if (explicitApiKey) {
    const provider = (env('FRAMESCRIPT_ASR_PROVIDER') || 'openai-compatible') as AsrProviderId;
    if (provider !== 'openai-compatible') {
      return { error: `Unsupported FRAMESCRIPT_ASR_PROVIDER "${provider}".` };
    }
    const model = env('FRAMESCRIPT_ASR_MODEL');
    if (!model) return { error: 'FRAMESCRIPT_ASR_MODEL is not set.' };

    return {
      provider,
      endpoint: env('FRAMESCRIPT_ASR_ENDPOINT') || DEFAULT_ASR_ENDPOINT,
      apiKey: explicitApiKey,
      model,
    };
  }

  // Vercel injects a short-lived OIDC token into deployed functions. AI Gateway
  // accepts that token directly, so production can transcribe without storing a
  // long-lived OpenAI credential in the project. A manually supplied Gateway
  // API key remains useful for local/non-Vercel deployments.
  const gatewayToken = env('AI_GATEWAY_API_KEY') || env('VERCEL_OIDC_TOKEN');
  if (gatewayToken) {
    return {
      provider: 'vercel-ai-gateway',
      endpoint: DEFAULT_GATEWAY_ASR_ENDPOINT,
      apiKey: gatewayToken,
      model: env('FRAMESCRIPT_GATEWAY_ASR_MODEL') || DEFAULT_GATEWAY_ASR_MODEL,
    };
  }

  return {
    error:
      'No transcription credential is available. Set FRAMESCRIPT_ASR_API_KEY, or deploy on Vercel with AI Gateway OIDC enabled.',
  };
}

export function readVisionConfig(): VisionConfig | { error: string } {
  const apiKey = env('FRAMESCRIPT_VISION_API_KEY');
  if (!apiKey) return { error: 'FRAMESCRIPT_VISION_API_KEY is not set.' };

  const provider = (env('FRAMESCRIPT_VISION_PROVIDER') || 'anthropic') as VisionProviderId;
  if (provider !== 'anthropic' && provider !== 'openai-compatible') {
    return { error: `Unsupported FRAMESCRIPT_VISION_PROVIDER "${provider}".` };
  }
  const model = env('FRAMESCRIPT_VISION_MODEL');
  if (!model) return { error: 'FRAMESCRIPT_VISION_MODEL is not set.' };

  const endpoint =
    env('FRAMESCRIPT_VISION_ENDPOINT') ||
    (provider === 'anthropic' ? DEFAULT_ANTHROPIC_ENDPOINT : '');
  if (!endpoint) return { error: 'FRAMESCRIPT_VISION_ENDPOINT is not set.' };

  return { provider, endpoint, apiKey, model };
}

export function isError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * Builds the capability report.
 *
 * Provider id and model name are included because they are not secrets and
 * they make a support conversation possible ("which model transcribed this?").
 * The endpoint and the key never are.
 */
export function capabilityReport(): CapabilityReport {
  const asr = readAsrConfig();
  const vision = readVisionConfig();
  return {
    transcription: isError(asr)
      ? { configured: false, reason: asr.error }
      : { configured: true, provider: asr.provider, model: asr.model },
    vision: isError(vision)
      ? { configured: false, reason: vision.error }
      : { configured: true, provider: vision.provider, model: vision.model },
    limits: {
      maxAudioBytes: LIMITS.maxAudioBytes,
      maxWindowMs: LIMITS.maxWindowMs,
      maxFramesPerRequest: LIMITS.maxFramesPerRequest,
      maxFrameBytes: LIMITS.maxFrameBytes,
    },
  };
}
