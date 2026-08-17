/**
 * Meaningful silence.
 *
 * A screenplay that prints "Silence." every time nobody speaks for a second is
 * unreadable. But a held pause before an answer is a real dramatic beat, and
 * losing it loses the scene.
 *
 * The rule used here: silence is reported when it is long *relative to the
 * local rhythm of the scene* and it sits between two utterances. A gap at the
 * end of a scene is just the scene ending.
 */

import type { MediaTimeMs, TimeRange } from '../utils/time';
import type { SpeechRegion } from './vad';

export interface SilenceGap extends TimeRange {
  durationMs: number;
  significant: boolean;
  /** How many times longer this gap is than the scene's typical pause. */
  relativeLength: number;
}

export interface SilenceOptions {
  /** Never report anything shorter than this, whatever the local rhythm. */
  absoluteMinMs?: number;
  /** Always significant beyond this, whatever the local rhythm. */
  absoluteSignificantMs?: number;
  /** Multiple of the median local gap that counts as a held pause. */
  relativeFactor?: number;
  /** How many neighbouring gaps define "local rhythm". */
  contextWindow?: number;
}

const SILENCE_DEFAULTS: Required<SilenceOptions> = {
  absoluteMinMs: 1_200,
  absoluteSignificantMs: 4_000,
  relativeFactor: 3,
  contextWindow: 6,
};

/**
 * Derives inter-utterance gaps from speech regions and marks which are
 * narratively significant.
 */
export function findSilences(
  regions: readonly SpeechRegion[],
  options: SilenceOptions = {},
): SilenceGap[] {
  const opts = { ...SILENCE_DEFAULTS, ...options };
  if (regions.length < 2) return [];

  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const rawGaps: { index: number; start: MediaTimeMs; end: MediaTimeMs }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1]!.end;
    const end = sorted[i]!.start;
    if (end > start) rawGaps.push({ index: rawGaps.length, start, end });
  }

  return rawGaps
    .map((gap) => {
      const durationMs = gap.end - gap.start;
      const local = medianAround(
        rawGaps.map((g) => g.end - g.start),
        gap.index,
        opts.contextWindow,
      );
      const relativeLength = local > 0 ? durationMs / local : 1;
      const significant =
        durationMs >= opts.absoluteSignificantMs ||
        (durationMs >= opts.absoluteMinMs && relativeLength >= opts.relativeFactor);
      return { start: gap.start, end: gap.end, durationMs, significant, relativeLength };
    })
    .filter((g) => g.durationMs >= opts.absoluteMinMs);
}

function medianAround(values: readonly number[], index: number, window: number): number {
  const from = Math.max(0, index - window);
  const to = Math.min(values.length, index + window + 1);
  const slice = values.slice(from, to).filter((_, i) => from + i !== index);
  if (slice.length === 0) return values[index] ?? 0;
  const sorted = [...slice].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** Screenplay phrasing for a significant pause. */
export function describeSilence(gap: SilenceGap): string {
  if (gap.durationMs >= 8_000) return 'A long silence.';
  if (gap.durationMs >= 4_000) return 'Silence.';
  return 'A pause.';
}
