/**
 * GET /api/capabilities
 *
 * Tells Studio, before any analysis starts, which evidence sources are actually
 * available. Studio uses it to label transcription and scene understanding as
 * Ready or Not configured instead of implying every mode does the same thing.
 *
 * Booleans, provider ids, model names and numeric limits only. No endpoint, no
 * key, no environment values.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { capabilityReport } from './_lib/config.js';
import { json, methodNotAllowed } from './_lib/http.js';
import { writeWebResponse } from './_lib/nodeAdapter.js';

export function GET(_request: Request): Response {
  return json(capabilityReport());
}

export const HEAD = GET;

/**
 * Direct tests call the one-argument Web form. Vercel calls the two-argument
 * Node form and requires the response to be written through `res`.
 */
export default function handler(request: Request): Response;
export default function handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
export default function handler(
  request: Request | IncomingMessage,
  response?: ServerResponse,
): Response | Promise<void> {
  if (request instanceof Request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
    return GET(request);
  }
  if (!response) throw new TypeError('Vercel Node response is required.');

  const method = (request.method ?? 'GET').toUpperCase();
  const result =
    method === 'GET' || method === 'HEAD' ? json(capabilityReport()) : methodNotAllowed('GET');
  return writeWebResponse(response, result);
}
