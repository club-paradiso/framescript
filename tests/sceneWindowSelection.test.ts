import { describe, expect, it } from 'vitest';
import {
  preferredSceneCaptureBudget,
  selectSceneWindowsForAnalysis,
} from '../web/src/analysis/sceneWindowSelection';

const windowAt = (start: number, importance: number) => ({
  start,
  end: start + 2_400,
  importance,
});

describe('scene-window capture budget', () => {
  it('captures substantially more short-film candidates than it sends remotely', () => {
    const budget = preferredSceneCaptureBudget(12, 177_850);
    expect(budget).toBeGreaterThan(12);
    expect(budget).toBeLessThanOrEqual(72);
  });

  it('stays disabled when remote scene understanding is disabled', () => {
    expect(preferredSceneCaptureBudget(0, 177_850)).toBe(0);
  });

  it('keeps long-media capture bounded for mobile memory', () => {
    expect(preferredSceneCaptureBudget(12, 3 * 60 * 60_000)).toBeLessThanOrEqual(72);
  });
});

describe('temporal scene-window selection', () => {
  it('spreads a tight request budget across the timeline instead of taking only early salience', () => {
    const windows = Array.from({ length: 20 }, (_, index) =>
      windowAt(index * 10_000, index < 8 ? 1 - index * 0.01 : 0.2),
    );

    const selected = selectSceneWindowsForAnalysis(windows, 4);
    expect(selected).toHaveLength(4);

    const starts = selected.map((window) => window.start);
    expect(starts[0]).toBeLessThan(50_000);
    expect(starts.some((start) => start >= 50_000 && start < 100_000)).toBe(true);
    expect(starts.some((start) => start >= 100_000 && start < 150_000)).toBe(true);
    expect(starts.some((start) => start >= 150_000)).toBe(true);
  });

  it('chooses the most important candidate inside each occupied temporal bucket', () => {
    const windows = [
      windowAt(0, 0.1),
      windowAt(10_000, 0.9),
      windowAt(60_000, 0.2),
      windowAt(70_000, 0.8),
    ];

    const selected = selectSceneWindowsForAnalysis(windows, 2);
    expect(selected.map((window) => window.start)).toEqual([10_000, 70_000]);
  });

  it('returns all candidates in chronological order when they fit the budget', () => {
    const windows = [windowAt(20_000, 0.8), windowAt(0, 0.4), windowAt(10_000, 0.7)];
    const selected = selectSceneWindowsForAnalysis(windows, 6);
    expect(selected.map((window) => window.start)).toEqual([0, 10_000, 20_000]);
  });

  it('returns no candidates for a zero request budget', () => {
    expect(selectSceneWindowsForAnalysis([windowAt(0, 1)], 0)).toEqual([]);
  });
});
