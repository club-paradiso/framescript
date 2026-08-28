/**
 * Sanitized diagnostics.
 *
 * A field report is only useful if it says which stage failed, on what media,
 * in which browser — and it is only *safe* if it cannot carry the user's film,
 * their transcript, or anyone's credentials out of the page.
 *
 * So the report is built from an allowlist. There is no "everything else"
 * branch: a value appears here because this file names it. Filenames are the
 * one piece of user-supplied text included, and they are stripped to a base
 * name and length-bounded, because a full path can identify a person.
 */

import type { AnalysisOutcome, PhaseId } from './runAnalysis';
import type { Capabilities } from './apiClient';

export interface DiagnosticsInput {
  version: string;
  file: { name: string; size: number; type: string };
  media: {
    durationMs?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  capabilities: Capabilities;
  outcome?: AnalysisOutcome;
  /** Overrides for tests; production reads the real browser. */
  environment?: { userAgent: string; platform: string; deviceMemory?: number };
}

export interface DiagnosticsReport {
  frameScript: string;
  generatedAt: string;
  browser: { userAgent: string; platform: string; deviceMemoryGb?: number };
  file: { name: string; sizeBytes: number; type: string };
  media: { durationMs?: number; width?: number; height?: number };
  configuration: {
    transcription: { configured: boolean; provider?: string; model?: string; reason?: string };
    vision: { configured: boolean; provider?: string; model?: string; reason?: string };
    endpointReachable: boolean;
  };
  analysis?: {
    lastPhase: PhaseId;
    aborted: boolean;
    stats: AnalysisOutcome['stats'];
    coverage: AnalysisOutcome['coverage'];
    requests: AnalysisOutcome['requests'];
    notices: { code: string; detail?: string }[];
  };
}

/** Filenames can carry a path, a person's name, or a very long string. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Drop control characters so a crafted filename cannot break out of its own
  // field when the report is pasted into an issue. Done by code point rather
  // than by a regex literal, which would embed the control characters here.
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}

/**
 * Truncates a developer-facing detail string.
 *
 * Details are constructed by FrameScript itself from status codes and exception
 * names — never from a provider's response body — but they are bounded anyway
 * so a pathological message cannot dominate the report.
 */
function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}…` : collapsed;
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  const environment = input.environment ?? {
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    platform:
      typeof navigator === 'undefined'
        ? 'unknown'
        : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ??
          navigator.platform ??
          'unknown'),
    ...(typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
      ? { deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory }
      : {}),
  };

  const report: DiagnosticsReport = {
    frameScript: input.version,
    generatedAt: new Date().toISOString(),
    browser: {
      userAgent: environment.userAgent.slice(0, 300),
      platform: environment.platform.slice(0, 80),
      ...(environment.deviceMemory === undefined
        ? {}
        : { deviceMemoryGb: environment.deviceMemory }),
    },
    file: {
      name: sanitizeFilename(input.file.name),
      sizeBytes: input.file.size,
      type: input.file.type || 'unknown',
    },
    media: {
      ...(input.media.durationMs === undefined
        ? {}
        : { durationMs: Math.round(input.media.durationMs) }),
      ...(input.media.videoWidth ? { width: input.media.videoWidth } : {}),
      ...(input.media.videoHeight ? { height: input.media.videoHeight } : {}),
    },
    configuration: {
      // Provider id and model are not secrets and are what a support
      // conversation actually needs. The endpoint and key are never read here.
      transcription: {
        configured: input.capabilities.transcription.configured,
        ...(input.capabilities.transcription.provider
          ? { provider: input.capabilities.transcription.provider }
          : {}),
        ...(input.capabilities.transcription.model
          ? { model: input.capabilities.transcription.model }
          : {}),
        ...(input.capabilities.transcription.reason
          ? { reason: input.capabilities.transcription.reason }
          : {}),
      },
      vision: {
        configured: input.capabilities.vision.configured,
        ...(input.capabilities.vision.provider
          ? { provider: input.capabilities.vision.provider }
          : {}),
        ...(input.capabilities.vision.model ? { model: input.capabilities.vision.model } : {}),
        ...(input.capabilities.vision.reason ? { reason: input.capabilities.vision.reason } : {}),
      },
      endpointReachable: input.capabilities.endpointReachable,
    },
  };

  if (input.outcome) {
    report.analysis = {
      lastPhase: input.outcome.lastPhase,
      aborted: input.outcome.aborted,
      stats: input.outcome.stats,
      coverage: input.outcome.coverage,
      requests: input.outcome.requests,
      notices: input.outcome.notices.map((notice) => {
        const detail = sanitizeDetail(notice.detail);
        return { code: notice.code, ...(detail ? { detail } : {}) };
      }),
    };
  }

  return report;
}

export function formatDiagnostics(report: DiagnosticsReport): string {
  return JSON.stringify(report, null, 2);
}
