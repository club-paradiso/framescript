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
export type VisionProviderId = 'anthropic' | 'openai-compatible' | 'vercel-ai-gateway';
export type GatewayAuthMethod = 'api-key' | 'oidc';

export interface AsrConfig {
  provider: AsrProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  gatewayAuthMethod?: GatewayAuthMethod;
}

export interface VisionConfig {
  provider: VisionProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  gatewayAuthMethod?: GatewayAuthMethod;
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
// OpenAI transcription currently reaches the provider through Gateway but is
// rejected for this Vercel customer with `customer_verification_required`.
// Fish Audio Transcribe 1 is a v4-compatible Gateway transcription model from
// a different provider, so it avoids making FrameScript availability depend on
// an unrelated OpenAI account-verification state. Operators can still override
// this model explicitly once another route is preferable.
const DEFAULT_GATEWAY_ASR_MODEL = 'fish-audio/transcribe-1';
const DEFAULT_GATEWAY_VISION_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
// GPT-5.6 Luna is still limited-preview and returned 403 for this deployment in
// production. Gemini 3.5 Flash Lite is a generally routable multimodal model
// with both Google and Vertex endpoints, so it is the safer default. Operators
// can still opt into Luna (or any later model) through the environment override.
const DEFAULT_GATEWAY_VISION_MODEL = 'google/gemini-3.5-flash-lite';
const DEFAULT_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

type VercelRequestContext = {
  headers?: Record<string, string>;
};

type VercelContextGlobal = typeof globalThis & {
  [VERCEL_REQUEST_CONTEXT]?: { get?: () => VercelRequestContext };
};

interface GatewayCredential {
  token: string;
  authMethod: GatewayAuthMethod;
}

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Vercel supplies the deployment OIDC token on the per-request runtime context.
 * Reading it here on every request avoids caching a short-lived credential. The
 * environment variable remains a fallback for local tooling and older runtimes.
 */
function vercelRuntimeOidcToken(): string {
  const context = (globalThis as VercelContextGlobal)[VERCEL_REQUEST_CONTEXT]?.get?.();
  const token = context?.headers?.['x-vercel-oidc-token'];
  return typeof token === 'string' ? token.trim() : '';
}

/**
 * AI Gateway's v4 protocol requires callers to state how the bearer token was
 * obtained. Do not infer this from token contents: API-key formats can change,
 * while the configuration source already tells us the answer exactly.
 */
function gatewayCredential(): GatewayCredential | null {
  const gatewayApiKey = env('AI_GATEWAY_API_KEY');
  if (gatewayApiKey) return { token: gatewayApiKey, authMethod: 'api-key' };

  const runtimeOidc = vercelRuntimeOidcToken();
  if (runtimeOidc) return { token: runtimeOidc, authMethod: 'oidc' };

  const environmentOidc = env('VERCEL_OIDC_TOKEN');
  if (environmentOidc) return { token: environmentOidc, authMethod: 'oidc' };

  return null;
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

  // Explicit Gateway keys remain useful outside Vercel. On Vercel, the
  // per-request context is authoritative because its OIDC token is refreshed by
  // the platform instead of being a process-lifetime snapshot.
  const gateway = gatewayCredential();
  if (gateway) {
    return {
      provider: 'vercel-ai-gateway',
      endpoint: DEFAULT_GATEWAY_ASR_ENDPOINT,
      apiKey: gateway.token,
      gatewayAuthMethod: gateway.authMethod,
      model: env('FRAMESCRIPT_GATEWAY_ASR_MODEL') || DEFAULT_GATEWAY_ASR_MODEL,
    };
  }

  return {
    error:
      'No transcription credential is available. Set FRAMESCRIPT_ASR_API_KEY, or deploy on Vercel with AI Gateway OIDC enabled.',
  };
}

export function readVisionConfig(): VisionConfig | { error: string } {
  const explicitApiKey = env('FRAMESCRIPT_VISION_API_KEY');
  if (explicitApiKey) {
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

    return { provider, endpoint, apiKey: explicitApiKey, model };
  }

  // Reuse the same short-lived deployment credential as transcription. The
  // Gateway's OpenAI-compatible chat endpoint accepts image data URLs, which is
  // exactly the wire format FrameScript's existing vision adapter already uses.
  const gateway = gatewayCredential();
  if (gateway) {
    return {
      provider: 'vercel-ai-gateway',
      endpoint: DEFAULT_GATEWAY_VISION_ENDPOINT,
      apiKey: gateway.token,
      gatewayAuthMethod: gateway.authMethod,
      model: env('FRAMESCRIPT_GATEWAY_VISION_MODEL') || DEFAULT_GATEWAY_VISION_MODEL,
    };
  }

  return {
    error:
      'No vision credential is available. Set FRAMESCRIPT_VISION_API_KEY, or deploy on Vercel with AI Gateway OIDC enabled.',
  };
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
