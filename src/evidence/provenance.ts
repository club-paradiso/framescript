/**
 * Provenance construction.
 *
 * Every screenplay element carries the ids of the evidence that justifies it.
 * The Evidence view renders this directly, and export can include it — which
 * means a reader can always check what FrameScript actually saw versus what it
 * concluded.
 */

import { corroborate, minConfidence } from './confidence';
import type { ConfidenceLevel, EvidenceEvent, EvidenceSourceId, Provenance } from './types';

export function provenanceFrom(
  events: readonly EvidenceEvent[],
  options: { inferred?: boolean; confidence?: ConfidenceLevel } = {},
): Provenance {
  const evidenceIds = events.map((e) => e.id);
  const sources = [...new Set(events.map((e) => e.source))];
  const confidence =
    options.confidence ??
    corroborate(
      events.map((e) => e.confidence),
      sources.length,
    );
  return {
    evidenceIds,
    sources,
    confidence,
    inferred: options.inferred ?? false,
  };
}

export function emptyProvenance(): Provenance {
  return { evidenceIds: [], sources: [], confidence: 'unknown', inferred: false };
}

/** Merges provenance from several elements (used when beats are combined). */
export function mergeProvenance(...items: readonly Provenance[]): Provenance {
  const present = items.filter(Boolean);
  if (present.length === 0) return emptyProvenance();
  const evidenceIds = [...new Set(present.flatMap((p) => p.evidenceIds))];
  const sources = [...new Set(present.flatMap((p) => p.sources))] as EvidenceSourceId[];
  return {
    evidenceIds,
    sources,
    // A merged claim is only as trustworthy as its weakest constituent.
    confidence: minConfidence(...present.map((p) => p.confidence)),
    inferred: present.some((p) => p.inferred),
  };
}

/** Human-readable source list for the Evidence view. */
export function describeSources(sources: readonly EvidenceSourceId[]): string {
  const labels: Record<EvidenceSourceId, string> = {
    subtitle: 'Subtitle',
    'audio-asr': 'Audio ASR',
    'audio-speaker': 'Speaker',
    'audio-event': 'Sound',
    'audio-silence': 'Silence',
    video: 'Video',
    ocr: 'On-screen text',
    playback: 'Playback',
    metadata: 'Metadata',
    user: 'User correction',
  };
  return sources.map((s) => labels[s]).join(' + ') || 'No source';
}

/** True when the element rests only on inference with no direct observation. */
export function isPurelyInferred(provenance: Provenance): boolean {
  return provenance.inferred && provenance.evidenceIds.length === 0;
}
