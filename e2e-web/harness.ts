/**
 * End-to-end harness: the built Studio, its real API routes, and a stub
 * provider.
 *
 * The point of doing it this way rather than intercepting `/api/*` in the page
 * is that everything between the browser and the provider is the production
 * implementation — request construction, multipart encoding, WAV framing,
 * server-side validation, size limits, error mapping and response shape. Only
 * the provider itself is replaced, because a test must not depend on a paid
 * third party being reachable.
 *
 * The stub is also where failure is injected: rate limiting, 5xx, and an
 * unconfigured deployment are all real code paths and all reachable from here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist-web', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

export type ProviderMode = 'ok' | 'rate-limited' | 'server-error' | 'unauthorized';

export interface ProviderStub {
  origin: string;
  close: () => Promise<void>;
  /** Transcripts handed back, in the order the provider produced them. */
  readonly transcripts: string[];
  readonly calls: number;
  mode: ProviderMode;
  /** Clears the counters. The stub is shared, so each test starts from zero. */
  reset: () => void;
}

/** A minimal OpenAI-compatible `/audio/transcriptions` stand-in. */
export async function startProviderStub(): Promise<ProviderStub> {
  let calls = 0;
  const transcripts: string[] = [];
  const state = { mode: 'ok' as ProviderMode };

  const server = createServer((request, response) => {
    // Drain the upload; the stub does not decode audio, it only answers.
    request.resume();
    request.on('end', () => {
      calls++;
      if (state.mode === 'rate-limited') {
        response.writeHead(429, { 'content-type': 'text/plain' });
        response.end('rate limited');
        return;
      }
      if (state.mode === 'server-error') {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('upstream exploded');
        return;
      }
      if (state.mode === 'unauthorized') {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('bad key');
        return;
      }
      const text = `Transcribed dialogue line ${calls}.`;
      transcripts.push(text);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ text, language: 'en', segments: [{ start: 0, end: 1, text }] }),
      );
    });
  });

  const origin = await listen(server);
  return {
    origin,
    close: () => close(server),
    get transcripts() {
      return transcripts;
    },
    get calls() {
      return calls;
    },
    get mode() {
      return state.mode;
    },
    set mode(value: ProviderMode) {
      state.mode = value;
    },
    reset() {
      calls = 0;
      transcripts.length = 0;
      state.mode = 'ok';
    },
  };
}

export interface VisionStub {
  origin: string;
  close: () => Promise<void>;
  readonly calls: number;
  /** Frames received per request, so a test can assert the payload is bounded. */
  readonly frameCounts: number[];
  mode: ProviderMode;
  reset: () => void;
}

/** A minimal Anthropic-shaped `/v1/messages` stand-in for vision windows. */
export async function startVisionStub(): Promise<VisionStub> {
  let calls = 0;
  const frameCounts: number[] = [];
  const state = { mode: 'ok' as ProviderMode };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls++;
      if (state.mode !== 'ok') {
        response.writeHead(state.mode === 'rate-limited' ? 429 : 500, {
          'content-type': 'text/plain',
        });
        response.end('vision unavailable');
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages?: { content?: { type?: string }[] }[];
        };
        frameCounts.push(
          (body.messages?.[0]?.content ?? []).filter((part) => part.type === 'image').length,
        );
      } catch {
        frameCounts.push(0);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                actions: [
                  {
                    offsetMs: 100,
                    description: 'A pale block slides across the frame',
                    participants: [],
                    confidence: 'medium',
                  },
                ],
                characters: [],
                settingChanges: [],
                text: [],
                uncertainties: ['the frames are abstract'],
              }),
            },
          ],
        }),
      );
    });
  });

  const origin = await listen(server);
  return {
    origin,
    close: () => close(server),
    get calls() {
      return calls;
    },
    get frameCounts() {
      return frameCounts;
    },
    get mode() {
      return state.mode;
    },
    set mode(value: ProviderMode) {
      state.mode = value;
    },
    reset() {
      calls = 0;
      frameCounts.length = 0;
      state.mode = 'ok';
    },
  };
}

export interface StudioServer {
  origin: string;
  close: () => Promise<void>;
  /** Same-origin API requests the browser actually made. */
  readonly apiRequests: string[];
}

/**
 * Serves `dist-web`, dispatching `/api/*` to the real route handlers.
 *
 * The handlers are imported lazily so that the environment variables a test
 * sets are read by the same process at request time, exactly as they would be
 * on the server.
 */
export async function startStudio(): Promise<StudioServer> {
  if (!existsSync(DIST)) throw new Error('dist-web/ not found — run `npm run build:web` first.');
  const apiRequests: string[] = [];

  const routes: Record<string, () => Promise<(request: Request) => Response | Promise<Response>>> =
    {
      '/api/capabilities': async () => (await import('../api/capabilities')).default,
      '/api/transcribe': async () => (await import('../api/transcribe')).default,
      '/api/analyze-frame': async () => (await import('../api/analyze-frame')).default,
    };

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const route = routes[path];
    if (route) {
      apiRequests.push(`${request.method} ${path}`);
      void dispatch(request, response, route);
      return;
    }
    if (path.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"code":"MESSAGE_INVALID","message":"No such endpoint."}');
      return;
    }
    serveStatic(path, response);
  });

  const origin = await listen(server);
  return {
    origin,
    close: () => close(server),
    get apiRequests() {
      return apiRequests;
    },
  };
}

async function dispatch(
  incoming: IncomingMessage,
  response: ServerResponse,
  load: () => Promise<(request: Request) => Response | Promise<Response>>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }

    const handler = await load();
    const result = await handler(
      new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
        method: incoming.method ?? 'GET',
        headers,
        ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
      }),
    );

    const outHeaders: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    response.writeHead(result.status, outHeaders);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'UNSUPPORTED', message: String(error) }));
  }
}

function serveStatic(path: string, response: ServerResponse): void {
  const relative = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, relative === '/' ? 'index.html' : relative);
  // Mirrors the production rewrite: application routes fall back to the shell,
  // and `/api/*` never reaches this function at all.
  if (!existsSync(filePath)) filePath = join(DIST, 'index.html');
  try {
    const body = readFileSync(filePath);
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Points the API routes at the stub. Cleared by `unconfigureProviders`. */
export function configureTranscription(stub: ProviderStub): void {
  process.env.FRAMESCRIPT_ASR_PROVIDER = 'openai-compatible';
  process.env.FRAMESCRIPT_ASR_API_KEY = 'e2e-test-key';
  process.env.FRAMESCRIPT_ASR_ENDPOINT = `${stub.origin}/v1/audio/transcriptions`;
  process.env.FRAMESCRIPT_ASR_MODEL = 'stub-whisper';
}

export function configureVision(stub: VisionStub): void {
  process.env.FRAMESCRIPT_VISION_PROVIDER = 'anthropic';
  process.env.FRAMESCRIPT_VISION_API_KEY = 'e2e-vision-key';
  process.env.FRAMESCRIPT_VISION_ENDPOINT = `${stub.origin}/v1/messages`;
  process.env.FRAMESCRIPT_VISION_MODEL = 'stub-vision';
}

export function unconfigureProviders(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FRAMESCRIPT_')) delete process.env[key];
  }
}
