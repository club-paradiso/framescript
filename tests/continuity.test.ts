import { describe, expect, it } from 'vitest';
import { ContinuityTracker } from '../src/ai/continuity';
import { buildVisionUserPrompt, VISION_SYSTEM_PROMPT } from '../src/ai/schemas/visionWindow';
import type { VisionWindowAnalysis } from '../src/ai/types';

function analysis(partial: Partial<VisionWindowAnalysis>): VisionWindowAnalysis {
  return { actions: [], characters: [], settingChanges: [], text: [], uncertainties: [], ...partial };
}

describe('continuity tracker', () => {
  it('hands the next window the last actions, labels and setting before it', () => {
    const tracker = new ContinuityTracker();
    tracker.observe(
      { start: 0, end: 4_000 },
      analysis({
        actions: [
          { offsetMs: 1_000, description: 'The man in the black shirt swings a baton', participants: [], confidence: 'high' },
        ],
        characters: [{ label: 'man in black shirt', present: true }],
        settingChanges: [
          { description: 'industrial laundry', interiorExterior: 'INT', confidence: 'medium' },
        ],
      }),
    );

    const context = tracker.contextAt(4_000);
    expect(context.recentActions).toEqual(['The man in the black shirt swings a baton']);
    expect(context.knownCharacters).toEqual([
      { id: 'man in black shirt', displayName: 'man in black shirt' },
    ]);
    expect(context.currentSetting).toBe('INT industrial laundry');
  });

  it('never leaks what happens at or after the window start', () => {
    const tracker = new ContinuityTracker();
    tracker.observe(
      { start: 0, end: 10_000 },
      analysis({
        actions: [{ offsetMs: 6_000, description: 'later', participants: [], confidence: 'high' }],
      }),
    );
    expect(tracker.contextAt(5_000).recentActions).toBeUndefined();
  });

  it('forgets actions beyond its lookback and absent characters', () => {
    const tracker = new ContinuityTracker({ actionLookbackMs: 5_000 });
    tracker.observe(
      { start: 0, end: 2_000 },
      analysis({
        actions: [{ offsetMs: 0, description: 'old', participants: [], confidence: 'high' }],
        characters: [{ label: 'gone', present: false }],
      }),
    );
    const context = tracker.contextAt(20_000);
    expect(context.recentActions).toBeUndefined();
    expect(context.knownCharacters).toEqual([]);
  });

  it('keeps at most the configured number of recent actions, newest last', () => {
    const tracker = new ContinuityTracker({ maxActions: 2 });
    tracker.observe(
      { start: 0, end: 4_000 },
      analysis({
        actions: [1, 2, 3].map((n) => ({
          offsetMs: n * 1_000,
          description: `a${n}`,
          participants: [],
          confidence: 'medium' as const,
        })),
      }),
    );
    expect(tracker.contextAt(4_000).recentActions).toEqual(['a2', 'a3']);
  });

  it('is empty after clear', () => {
    const tracker = new ContinuityTracker();
    tracker.observe(
      { start: 0, end: 1_000 },
      analysis({ characters: [{ label: 'x', present: true }] }),
    );
    tracker.clear();
    expect(tracker.contextAt(1_000)).toEqual({ knownCharacters: [] });
  });
});

describe('continuity in the vision prompt', () => {
  it('states earlier observations as context, not as something to repeat', () => {
    const prompt = buildVisionUserPrompt({
      start: 0,
      end: 4_000,
      frames: [],
      dialogue: [],
      soundEvents: [],
      knownCharacters: [{ id: 'man in black shirt', displayName: 'man in black shirt' }],
      recentActions: ['The man swings a baton'],
    });
    expect(prompt).toContain('OBSERVED JUST BEFORE THIS WINDOW');
    expect(prompt).toContain('describe only what these frames show');
    expect(prompt).toContain('  - The man swings a baton');
    expect(prompt).toContain('KNOWN CHARACTER LABELS: man in black shirt');
  });

  it('tells the model to reuse supplied labels', () => {
    expect(VISION_SYSTEM_PROMPT).toMatch(/reuse the matching label exactly/);
  });
});
