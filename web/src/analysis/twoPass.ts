/**
 * Two-pass scene understanding.
 *
 * The playback scan picks windows by how much the picture *moves*. That misses
 * what matters most when little moves: an injury in close-up, a held stare, a
 * hand on a lever. The two-pass plan fixes the selection, not the scan:
 *
 *   1. Overview: the whole file as a few coarse contact sheets (one tile every
 *      couple of seconds), described in order. The overview is never written
 *      into the screenplay; it only says *where* something happens and keeps
 *      labels and setting consistent between windows.
 *   2. Dense: windows the overview flagged are promoted, and flagged moments
 *      no scan window covers get a dense sheet of their own, captured by
 *      seeking. The usual budgeted selection then runs over the result.
 *
 * Everything here is bounded: the overview is at most `OVERVIEW_MAX_SHEETS`
 * requests, and added dense sheets at most `maxNew`.
 */

import type { MediaTimeMs, VisionWindowAnalysis } from '@/core';
import type { SheetGeometry, SheetPlan } from './contactSheet';

/** 6x5 = 30 tiles, the endpoint's sheet ceiling. Small tiles: this pass locates, it does not describe. */
export const OVERVIEW_GEOMETRY: SheetGeometry = { columns: 6, rows: 5, tileWidth: 192 };
export const OVERVIEW_MAX_SHEETS = 8;
/** Finer than this spends overview requests on a short clip that dense sheets already cover. */
const OVERVIEW_MIN_INTERVAL_MS = 2_000;

/** How much an overview action's confidence says about where to look closer. */
const CONFIDENCE_WEIGHT = { high: 1, medium: 0.8, low: 0.55, unknown: 0.5 } as const;

export interface SalientMoment {
  at: MediaTimeMs;
  weight: number;
}

export interface OverviewResult {
  start: MediaTimeMs;
  end: MediaTimeMs;
  analysis: VisionWindowAnalysis;
}

/**
 * Plans overview sheets that cover the whole file evenly.
 *
 * The tile interval grows with the file so the overview never exceeds
 * `OVERVIEW_MAX_SHEETS` requests: two seconds for anything up to eight
 * minutes, half a minute for a two-hour film.
 */
export function planOverview(durationMs: MediaTimeMs): SheetPlan[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const perSheet = OVERVIEW_GEOMETRY.columns * OVERVIEW_GEOMETRY.rows;
  const raw = durationMs / (perSheet * OVERVIEW_MAX_SHEETS);
  const interval = Math.max(OVERVIEW_MIN_INTERVAL_MS, Math.ceil(raw / 500) * 500);

  const tiles: MediaTimeMs[] = [];
  for (let t = Math.min(interval / 2, durationMs / 2); t < durationMs; t += interval) {
    tiles.push(Math.round(t));
  }

  const plans: SheetPlan[] = [];
  for (let i = 0; i < tiles.length && plans.length < OVERVIEW_MAX_SHEETS; i += perSheet) {
    const tileTimestamps = tiles.slice(i, i + perSheet);
    const start = tileTimestamps[0]!;
    const last = tileTimestamps[tileTimestamps.length - 1]!;
    plans.push({
      start,
      end: Math.max(last, start + 1),
      tileTimestamps,
      geometry: OVERVIEW_GEOMETRY,
    });
  }
  return plans;
}

/** Where the overview saw something happen, weighted by its confidence. */
export function salientMoments(results: readonly OverviewResult[]): SalientMoment[] {
  const moments: SalientMoment[] = [];
  for (const { start, end, analysis } of results) {
    const span = Math.max(0, end - start);
    for (const action of analysis.actions) {
      if (!action.description.trim()) continue;
      moments.push({
        at: start + Math.min(Math.max(action.offsetMs, 0), span),
        weight: CONFIDENCE_WEIGHT[action.confidence] ?? CONFIDENCE_WEIGHT.unknown,
      });
    }
  }
  return moments.sort((a, b) => a.at - b.at);
}

interface Promotable {
  start: MediaTimeMs;
  end: MediaTimeMs;
  importance: number;
}

/**
 * Raises a window's importance to the weight of any salient moment within
 * `radiusMs` of it. Content judged important beats motion judged large.
 */
export function promoteWindows<T extends Promotable>(
  windows: T[],
  moments: readonly SalientMoment[],
  radiusMs: number,
): T[] {
  for (const window of windows) {
    for (const moment of moments) {
      if (moment.at >= window.start - radiusMs && moment.at <= window.end + radiusMs) {
        window.importance = Math.max(window.importance, moment.weight);
      }
    }
  }
  return windows;
}

/**
 * Dense sheets for salient moments that no existing window covers.
 *
 * Strongest moments first; a moment inside a window already planned is
 * skipped, so two nearby moments share one sheet. Each sheet starts a little
 * before its moment, because how an action arrives is part of the action.
 */
export function planDenseSheets(
  moments: readonly SalientMoment[],
  covered: readonly { start: MediaTimeMs; end: MediaTimeMs }[],
  durationMs: MediaTimeMs,
  geometry: SheetGeometry,
  tileIntervalMs: number,
  maxNew: number,
  leadInMs = 1_500,
): (SheetPlan & { importance: number })[] {
  if (maxNew <= 0 || durationMs <= 0) return [];
  const span = geometry.columns * geometry.rows * tileIntervalMs;
  const planned: (SheetPlan & { importance: number })[] = [];
  const isCovered = (at: MediaTimeMs) =>
    covered.some((w) => at >= w.start && at <= w.end) ||
    planned.some((w) => at >= w.start && at <= w.end);

  for (const moment of [...moments].sort((a, b) => b.weight - a.weight || a.at - b.at)) {
    if (planned.length >= maxNew) break;
    if (isCovered(moment.at)) continue;
    const start = Math.max(0, Math.min(moment.at - leadInMs, durationMs - span));
    const tileTimestamps: MediaTimeMs[] = [];
    for (let i = 0; i < geometry.columns * geometry.rows; i++) {
      const t = Math.round(start + i * tileIntervalMs);
      if (t >= durationMs) break;
      tileTimestamps.push(t);
    }
    if (tileTimestamps.length === 0) continue;
    planned.push({
      start: tileTimestamps[0]!,
      end: Math.max(tileTimestamps[tileTimestamps.length - 1]!, tileTimestamps[0]! + 1),
      tileTimestamps,
      geometry,
      importance: moment.weight,
    });
  }
  return planned.sort((a, b) => a.start - b.start);
}
