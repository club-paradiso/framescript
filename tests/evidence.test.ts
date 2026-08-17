import { describe, expect, it } from 'vitest';
import { EvidenceTimeline } from '@/evidence/timeline';
import { buildEvidenceWindows, emptyWindow, windowIsEmpty } from '@/evidence/windows';
import { corroborate, derive, fromScore, minConfidence, maxConfidence } from '@/evidence/confidence';
import { describeSources, mergeProvenance, provenanceFrom } from '@/evidence/provenance';
import { coveredDuration, invertRanges, mergeRanges, temporalIou } from '@/utils/time';
import type { EvidenceEvent, SubtitleEvidence, VisualEvidence } from '@/evidence/types';

let counter = 0;
const id = () => `e${++counter}`;

const subtitle = (start: number, end: number, text: string, language = 'en'): SubtitleEvidence => ({
  id: id(),
  source: 'subtitle',
  start,
  end,
  confidence: 'high',
  provisional: false,
  payload: { text, language },
});

const visual = (start: number, kind: VisualEvidence['payload']['kind'], score = 0.8): VisualEvidence => ({
  id: id(),
  source: 'video',
  start,
  confidence: 'medium',
  provisional: false,
  payload: { kind, metrics: { sceneCutScore: score } },
});

describe('confidence arithmetic', () => {
  it('is ordinal, not numeric', () => {
    expect(minConfidence('high', 'low')).toBe('low');
    expect(maxConfidence('high', 'low')).toBe('high');
    expect(minConfidence()).toBe('unknown');
  });

  it('raises confidence when independent sources agree', () => {
    expect(corroborate(['medium', 'medium'], 2)).toBe('high');
    // Two events from the same source are not corroboration.
    expect(corroborate(['medium', 'medium'], 1)).toBe('medium');
  });

  it('never exceeds high, however many sources agree', () => {
    expect(corroborate(['high', 'high', 'high'], 5)).toBe('high');
  });

  it('costs a step for inference', () => {
    expect(derive('high', true)).toBe('medium');
    expect(derive('high', false)).toBe('high');
    expect(derive('unknown', true)).toBe('unknown');
  });

  it('caps a lone heuristic score at medium', () => {
    // A local frame-difference score is weak evidence, whatever its magnitude.
    expect(fromScore(0.95)).toBe('medium');
    expect(fromScore(0.95, { strongEvidence: true })).toBe('high');
    expect(fromScore(0)).toBe('unknown');
    expect(fromScore(Number.NaN)).toBe('unknown');
  });
});

describe('provenance', () => {
  it('records every contributing event and source', () => {
    const events = [subtitle(0, 1000, 'Hello'), visual(500, 'action')];
    const provenance = provenanceFrom(events);
    expect(provenance.evidenceIds).toHaveLength(2);
    expect(provenance.sources).toEqual(['subtitle', 'video']);
    expect(provenance.inferred).toBe(false);
  });

  it('takes the weakest constituent when merging', () => {
    const merged = mergeProvenance(
      { evidenceIds: ['a'], sources: ['subtitle'], confidence: 'high', inferred: false },
      { evidenceIds: ['b'], sources: ['video'], confidence: 'low', inferred: true },
    );
    expect(merged.confidence).toBe('low');
    expect(merged.inferred).toBe(true);
    expect(merged.evidenceIds).toEqual(['a', 'b']);
  });

  it('describes sources readably', () => {
    expect(describeSources(['subtitle', 'audio-asr'])).toBe('Subtitle + Audio ASR');
    expect(describeSources([])).toBe('No source');
  });
});

describe('time ranges', () => {
  it('merges overlapping and adjacent ranges', () => {
    expect(mergeRanges([{ start: 0, end: 100 }, { start: 50, end: 200 }])).toEqual([{ start: 0, end: 200 }]);
    expect(mergeRanges([{ start: 0, end: 100 }, { start: 300, end: 400 }])).toHaveLength(2);
    // Tolerance closes scheduling-jitter gaps.
    expect(mergeRanges([{ start: 0, end: 100 }, { start: 140, end: 200 }], 50)).toHaveLength(1);
  });

  it('computes covered duration without double counting overlaps', () => {
    expect(coveredDuration([{ start: 0, end: 100 }, { start: 50, end: 150 }])).toBe(150);
  });

  it('inverts coverage into the ranges that were never observed', () => {
    const gaps = invertRanges([{ start: 0, end: 1000 }, { start: 3000, end: 4000 }], 5000);
    expect(gaps).toEqual([{ start: 1000, end: 3000 }, { start: 4000, end: 5000 }]);
  });

  it('measures temporal IoU', () => {
    expect(temporalIou({ start: 0, end: 100 }, { start: 0, end: 100 })).toBe(1);
    expect(temporalIou({ start: 0, end: 100 }, { start: 200, end: 300 })).toBe(0);
    expect(temporalIou({ start: 0, end: 100 }, { start: 50, end: 150 })).toBeCloseTo(1 / 3, 5);
  });
});

describe('evidence timeline', () => {
  it('stores and retrieves events by id', () => {
    const timeline = new EvidenceTimeline();
    const event = subtitle(1000, 2000, 'Hello');
    timeline.append(event);
    expect(timeline.get(event.id)).toBe(event);
    expect(timeline.size).toBe(1);
  });

  it('keeps events ordered by media time regardless of arrival order', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(3000, 4000, 'Third'));
    timeline.append(subtitle(1000, 2000, 'First'));
    timeline.append(subtitle(2000, 3000, 'Second'));
    expect(timeline.all().map((e) => e.start)).toEqual([1000, 2000, 3000]);
  });

  it('deduplicates the same subtitle re-observed within the window', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(1000, 2000, 'Where are you?'));
    const second = timeline.append(subtitle(1200, 2400, 'Where are you?'));
    expect(second.added).toBe(false);
    expect(timeline.size).toBe(1);
    // The retained event is extended to cover the whole display.
    expect(timeline.all()[0]!.end).toBe(2400);
  });

  it('does not deduplicate the same line spoken again much later', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(1000, 2000, 'I know'));
    timeline.append(subtitle(60_000, 61_000, 'I know'));
    expect(timeline.size).toBe(2);
  });

  it('treats the same text in different languages as separate evidence', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(1000, 2000, 'Hello', 'en'));
    timeline.append(subtitle(1000, 2000, 'Hello', 'ko'));
    expect(timeline.size).toBe(2);
  });

  it('updates an event re-appended under the same id', () => {
    const timeline = new EvidenceTimeline();
    const event = subtitle(1000, 2000, 'Draft');
    timeline.append(event);
    timeline.append({ ...event, payload: { ...event.payload, text: 'Final' }, provisional: false });
    expect(timeline.size).toBe(1);
    expect((timeline.all()[0] as SubtitleEvidence).payload.text).toBe('Final');
  });

  it('returns events overlapping a range', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(0, 1000, 'A'));
    timeline.append(subtitle(2000, 3000, 'B'));
    timeline.append(subtitle(5000, 6000, 'C'));
    expect(timeline.range(1500, 4000).map((e) => (e as SubtitleEvidence).payload.text)).toEqual(['B']);
  });

  it('tracks observation coverage and reports gaps honestly', () => {
    const timeline = new EvidenceTimeline();
    timeline.setDuration(10_000);
    timeline.markObserved(0, 3_000);
    timeline.markObserved(7_000, 10_000);

    expect(timeline.coverageRatio()).toBeCloseTo(0.6, 5);
    expect(timeline.uncoveredRanges()).toEqual([{ start: 3_000, end: 7_000 }]);
  });

  it('reports unknown coverage when duration is unknown', () => {
    const timeline = new EvidenceTimeline();
    timeline.markObserved(0, 1000);
    expect(timeline.coverageRatio()).toBeUndefined();
    expect(timeline.uncoveredRanges()).toEqual([]);
  });

  it('notifies subscribers and stops on unsubscribe', () => {
    const timeline = new EvidenceTimeline();
    const seen: string[] = [];
    const unsubscribe = timeline.subscribe((e) => seen.push(e.id));
    timeline.append(subtitle(0, 1000, 'A'));
    unsubscribe();
    timeline.append(subtitle(2000, 3000, 'B'));
    expect(seen).toHaveLength(1);
  });

  it('evicts the least informative events when full, keeping dialogue', () => {
    const timeline = new EvidenceTimeline({ maxEvents: 100 });
    // Fill with low-value silence evidence plus a few subtitles.
    for (let i = 0; i < 120; i++) {
      timeline.append({
        id: id(),
        source: 'audio-silence',
        start: i * 1000,
        confidence: 'low',
        provisional: false,
        payload: { durationMs: 500, significant: false },
      } as EvidenceEvent);
    }
    const keptSubtitle = subtitle(500_000, 501_000, 'Important line');
    timeline.append(keptSubtitle);

    expect(timeline.size).toBeLessThanOrEqual(120);
    expect(timeline.evictedCount).toBeGreaterThan(0);
    // Dialogue must never be the first thing dropped.
    expect(timeline.get(keptSubtitle.id)).toBeDefined();
  });

  it('clears completely on reset', () => {
    const timeline = new EvidenceTimeline();
    timeline.append(subtitle(0, 1000, 'A'));
    timeline.markObserved(0, 1000);
    timeline.clear();
    expect(timeline.size).toBe(0);
    expect(timeline.coverage().observed).toEqual([]);
  });
});

describe('evidence windows', () => {
  it('recognises an empty window', () => {
    expect(windowIsEmpty(emptyWindow(0, 1000))).toBe(true);
  });

  it('always cuts a window at a scene change', () => {
    const events = [
      subtitle(0, 1500, 'Before'),
      visual(2000, 'scene-change'),
      subtitle(2500, 4000, 'After'),
    ];
    const windows = buildEvidenceWindows(events, { start: 0, end: 6000 });
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows.some((w) => w.start === 2000)).toBe(true);
  });

  it('always cuts a window at a seek', () => {
    const events: EvidenceEvent[] = [
      subtitle(0, 1000, 'Before'),
      {
        id: id(),
        source: 'playback',
        start: 2000,
        confidence: 'high',
        provisional: false,
        payload: { kind: 'seek', fromTime: 2000 },
      },
      subtitle(2500, 3500, 'After'),
    ];
    const windows = buildEvidenceWindows(events, { start: 0, end: 5000 });
    expect(windows.some((w) => w.start === 2000)).toBe(true);
  });

  it('subdivides a long stretch with no cuts', () => {
    const events = Array.from({ length: 12 }, (_, i) => subtitle(i * 4000, i * 4000 + 2000, `Line ${i}`));
    const windows = buildEvidenceWindows(events, { start: 0, end: 48_000 }, { maxDurationMs: 12_000 });
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(window.end - window.start).toBeLessThanOrEqual(13_000);
    }
  });

  it('places each event in its typed bucket', () => {
    const events = [subtitle(0, 1000, 'Line'), visual(500, 'action')];
    const [window] = buildEvidenceWindows(events, { start: 0, end: 2000 });
    expect(window!.subtitles).toHaveLength(1);
    expect(window!.visualEvents).toHaveLength(1);
  });

  it('returns nothing for an empty evidence set', () => {
    expect(buildEvidenceWindows([], { start: 0, end: 1000 })).toEqual([]);
  });
});
