import { describe, expect, it } from 'vitest';
import { detectSceneBoundaries } from '@/scenes/boundaries';
import type { SubtitleEvidence } from '@/evidence/types';

let counter = 0;

const subtitle = (
  start: number,
  end: number,
  language: string,
  text: string,
): SubtitleEvidence => ({
  id: `boundary-multilingual-${++counter}`,
  source: 'subtitle',
  start,
  end,
  confidence: 'high',
  provisional: false,
  payload: { text, language },
});

const multilingualTrack = (starts: readonly number[], durationMs = 2_000) =>
  starts.flatMap((start, index) => [
    subtitle(start, start + durationMs, 'en', `Line ${index}`),
    subtitle(start, start + durationMs, 'ko', `대사 ${index}`),
  ]);

describe('multilingual dialogue-gap rhythm', () => {
  it('does not let aligned translations collapse the median gap to zero', () => {
    // Every cue is separated by the same 30-second silence. That is the normal
    // rhythm of this sparse track, so adding a second aligned language must not
    // turn every ordinary pause into a scene boundary.
    const starts = Array.from({ length: 12 }, (_, index) => index * 32_000);

    expect(detectSceneBoundaries(multilingualTrack(starts))).toHaveLength(0);
  });

  it('still detects an exceptional gap when the same speech exists in two languages', () => {
    // Normal rhythm is two seconds of silence between two-second cues, followed
    // by one exceptional 88-second hole. Merging aligned tracks must remove only
    // duplicate speech intervals, not the real long gap between them.
    const starts = [0, 4_000, 8_000, 12_000, 16_000, 20_000, 110_000, 114_000, 118_000];

    expect(detectSceneBoundaries(multilingualTrack(starts)).length).toBeGreaterThanOrEqual(1);
  });
});
