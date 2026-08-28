/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Bridges Vercel's legacy `(req, res)` Node function signature to the Web
 * Request/Response handlers used by FrameScript's tested API implementation.
 *
 * Vercel treats a default export as the Node signature. Returning a Web
 * `Response` from that default export is ignored, so the adapter buffers the
 * already-bounded request body, constructs a Web Request, then writes the Web
 * Response back through ServerResponse.
 */
export async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const part of value) headers.append(name, part);
    } else {
      headers.set(name, value);
    }
  }

  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']);
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const protocol = forwardedProto || 'https';
  const host = forwardedHost || request.headers.host || 'localhost';
  const url = new URL(request.url ?? '/', `${protocol}://${host}`);

  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  return new Request(url, { method, headers, body: arrayBuffer });
}

export async function writeWebResponse(
  target: ServerResponse,
  response: Response,
): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  const body = new Uint8Array(await response.arrayBuffer());
  target.end(Buffer.from(body));
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
