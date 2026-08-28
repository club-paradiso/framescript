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

import { capabilityReport } from './_lib/config.js';
import { json, methodNotAllowed } from './_lib/http.js';

export function GET(_request: Request): Response {
  return json(capabilityReport());
}

export const HEAD = GET;

/** Kept for direct unit/E2E invocation outside Vercel. */
export default function handler(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
  return GET(request);
}
