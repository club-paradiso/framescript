import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_GEOMETRY,
  OVERVIEW_MAX_SHEETS,
  planDenseSheets,
  planOverview,
  promoteWindows,
  salientMoments,
} from '../web/src/analysis/twoPass';
import type { VisionWindowAnalysis } from '../src/ai/types';

const TILE_CAPACITY = OVERVIEW_GEOMETRY.columns * OVERVIEW_GEOMETRY.rows;
const dense = { columns: 4, rows: 4, tileWidth: 320 };

function analysis(actions: [number, 'high' | 'medium' | 'low' | 'unknown'][]): VisionWindowAnalysis {
  return {
    actions: actions.map(([offsetMs, confidence]) => ({
      offsetMs,
      description: 'something happens',
      participants: [],
      confidence,
    })),
    characters: [],
    settingChanges: [],
    text: [],
    uncertainties: [],
  };
}

describe('overview plan', () => {
  it('covers a short clip every two seconds in a few sheets', () => {
    const plans = planOverview(136_470);
    const tiles = plans.flatMap((plan) => plan.tileTimestamps);
    expect(tiles[1]! - tiles[0]!).toBe(2_000);
    expect(tiles.at(-1)!).toBeGreaterThan(134_000);
    expect(plans).toHaveLength(Math.ceil(tiles.length / TILE_CAPACITY));
    for (const plan of plans) {
      expect(plan.tileTimestamps.length).toBeLessThanOrEqual(TILE_CAPACITY);
      expect(plan.start).toBe(plan.tileTimestamps[0]);
      expect(plan.end).toBeGreaterThan(plan.start);
    }
  });

  it('stays within its request ceiling for a feature film', () => {
    const plans = planOverview(2 * 60 * 60_000);
    expect(plans.length).toBeLessThanOrEqual(OVERVIEW_MAX_SHEETS);
    const tiles = plans.flatMap((plan) => plan.tileTimestamps);
    expect(tiles.at(-1)!).toBeGreaterThan(2 * 60 * 60_000 - 60_000);
  });

  it('plans nothing for an unknown duration', () => {
    expect(planOverview(0)).toEqual([]);
    expect(planOverview(Number.NaN)).toEqual([]);
  });

  it('still samples a clip shorter than one interval', () => {
    expect(planOverview(1_500)[0]!.tileTimestamps).toEqual([750]);
  });
});

describe('salient moments', () => {
  it('places overview actions in media time, weighted by confidence', () => {
    const moments = salientMoments([
      { start: 10_000, end: 70_000, analysis: analysis([[5_000, 'high'], [20_000, 'low']]) },
    ]);
    expect(moments).toEqual([
      { at: 15_000, weight: 1 },
      { at: 30_000, weight: 0.55 },
    ]);
  });

  it('clamps offsets into the overview window', () => {
    const moments = salientMoments([
      { start: 0, end: 1_000, analysis: analysis([[99_000, 'medium']]) },
    ]);
    expect(moments[0]!.at).toBe(1_000);
  });
});

describe('window promotion', () => {
  it('raises a quiet window near a salient moment above a busy one elsewhere', () => {
    const windows = [
      { start: 0, end: 4_000, importance: 0.9 },
      { start: 20_000, end: 24_000, importance: 0.15 },
    ];
    promoteWindows(windows, [{ at: 25_000, weight: 1 }], 1_000);
    expect(windows[1]!.importance).toBe(1);
    expect(windows[0]!.importance).toBe(0.9);
  });

  it('never lowers an importance', () => {
    const windows = [{ start: 0, end: 4_000, importance: 0.9 }];
    promoteWindows(windows, [{ at: 1_000, weight: 0.5 }], 1_000);
    expect(windows[0]!.importance).toBe(0.9);
  });
});

describe('dense sheets for uncovered moments', () => {
  it('starts a sheet shortly before an uncovered moment', () => {
    const plans = planDenseSheets([{ at: 30_000, weight: 1 }], [], 120_000, dense, 250, 4);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.start).toBe(28_500);
    expect(plans[0]!.tileTimestamps).toHaveLength(16);
    expect(plans[0]!.tileTimestamps[1]! - plans[0]!.tileTimestamps[0]!).toBe(250);
    expect(plans[0]!.importance).toBe(1);
  });

  it('skips moments an existing window already covers', () => {
    const plans = planDenseSheets(
      [{ at: 30_000, weight: 1 }],
      [{ start: 29_000, end: 33_000 }],
      120_000,
      dense,
      250,
      4,
    );
    expect(plans).toEqual([]);
  });

  it('lets nearby moments share one sheet and keeps the strongest first', () => {
    const plans = planDenseSheets(
      [
        { at: 10_000, weight: 0.55 },
        { at: 30_000, weight: 1 },
        { at: 31_000, weight: 0.8 },
      ],
      [],
      120_000,
      dense,
      250,
      1,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.start).toBe(28_500);
  });

  it('keeps a sheet inside the file near its end', () => {
    const plans = planDenseSheets([{ at: 119_500, weight: 1 }], [], 120_000, dense, 250, 1);
    expect(plans[0]!.tileTimestamps.at(-1)!).toBeLessThan(120_000);
    expect(plans[0]!.tileTimestamps).toHaveLength(16);
  });

  it('plans nothing without budget', () => {
    expect(planDenseSheets([{ at: 1_000, weight: 1 }], [], 10_000, dense, 250, 0)).toEqual([]);
  });
});
