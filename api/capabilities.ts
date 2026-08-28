/**
 * GET /api/capabilities
 *
 * Tells Studio, before any analysis starts, which evidence sources are actually
 * available. Studio uses it to label transcription and scene understanding as
 * Ready or Not configured instead of implying every mode does the same thing.
 *
 * Provider ids, model names, numeric limits, and deployment identity only. No
 * endpoint, credential, or arbitrary environment value is exposed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { capabilityReport } from './_lib/config.js';
import { json, methodNotAllowed } from './_lib/http.js';
import { writeWebResponse } from './_lib/nodeAdapter.js';

function reportWithDeploymentIdentity() {
  return {
    ...capabilityReport(),
    deployment: {
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      environment: process.env.VERCEL_ENV ?? null,
    },
  };
}

export function GET(_request: Request): Response {
  return json(reportWithDeploymentIdentity());
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
    method === 'GET' || method === 'HEAD'
      ? json(reportWithDeploymentIdentity())
      : methodNotAllowed('GET');
  return writeWebResponse(response, result);
}
