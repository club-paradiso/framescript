/**
 * Speech-window planning for transcription.
 *
 * VAD says *where* someone spoke. A transcription provider wants short, whole
 * utterances with a little air around them. Those are not the same thing, and
 * the gap between them is where cost, latency and alignment quality are won or
 * lost:
 *
 *   - two regions 200 ms apart are one sentence with a breath in it, and
 *     sending them separately produces two truncated fragments;
 *   - a 4-minute region is a monologue that no provider will align usefully and
 *     that every provider will charge for;
 *   - a 120 ms region is a cough.
 *
 * So planning happens here, once, as a pure function over regions — testable
 * without a provider, a network, or a browser. Nothing in this file performs
 * I/O or knows which provider will be used.
 */

import type { SpeechRegion } from '../audio/vad';
import type { MediaTimeMs, TimeRange } from '../utils/time';

export interface SpeechWindow extends TimeRange {
  /** Indices of the VAD regions this window covers, in order. */
  regionIndices: number[];
  /** True when a long region had to be split and this is not its first part. */
  continuation: boolean;
}

export interface SpeechWindowOptions {
  /** Hard cap per request. Providers align badly past ~30 s. */
  maxWindowMs?: number;
  /** Regions closer together than this are one utterance. */
  mergeGapMs?: number;
  /** Anything shorter is not worth a request. */
  minWindowMs?: number;
  /** Air added either side, clamped to the media. Helps onsets survive. */
  padMs?: number;
  /** Total speech budget across the whole file. Protects against surprise cost. */
  maxTotalMs?: number;
  /** Media duration, so padding cannot run past the end. */
  durationMs?: MediaTimeMs;
}

export interface SpeechWindowPlan {
  windows: SpeechWindow[];
  /** Sum of window durations, i.e. what would actually be transmitted. */
  totalMs: number;
  /** Speech that fell outside the budget. Reported, never silently dropped. */
  skippedForBudgetMs: number;
  /** Speech below `minWindowMs`, which is not worth a request. */
  skippedAsTooShortMs: number;
}

const DEFAULTS = {
  maxWindowMs: 28_000,
  mergeGapMs: 400,
  minWindowMs: 320,
  padMs: 120,
  maxTotalMs: 45 * 60_000,
} as const;

/**
 * Groups, pads, splits and budgets VAD regions into transcription windows.
 *
 * Windows are returned in media order and never overlap, so a transcript
 * assembled from them reads in sequence without deduplication.
 */
export function planSpeechWindows(
  regions: readonly SpeechRegion[],
  options: SpeechWindowOptions = {},
): SpeechWindowPlan {
  const maxWindowMs = Math.max(1_000, options.maxWindowMs ?? DEFAULTS.maxWindowMs);
  const mergeGapMs = Math.max(0, options.mergeGapMs ?? DEFAULTS.mergeGapMs);
  const minWindowMs = Math.max(0, options.minWindowMs ?? DEFAULTS.minWindowMs);
  const padMs = Math.max(0, options.padMs ?? DEFAULTS.padMs);
  const maxTotalMs = Math.max(0, options.maxTotalMs ?? DEFAULTS.maxTotalMs);

  const ordered = [...regions]
    .map((region, index) => ({ region, index }))
    .filter((entry) => entry.region.end > entry.region.start)
    .sort((a, b) => a.region.start - b.region.start);

  // --- Group regions separated by less than the merge gap ---------------------
  interface Group {
    start: MediaTimeMs;
    end: MediaTimeMs;
    regionIndices: number[];
  }
  const groups: Group[] = [];
  for (const { region, index } of ordered) {
    const previous = groups[groups.length - 1];
    if (previous && region.start - previous.end <= mergeGapMs) {
      previous.end = Math.max(previous.end, region.end);
      previous.regionIndices.push(index);
      continue;
    }
    groups.push({ start: region.start, end: region.end, regionIndices: [index] });
  }

  // --- Pad, then split anything longer than one request may carry -------------
  const windows: SpeechWindow[] = [];
  let skippedAsTooShortMs = 0;
  let skippedForBudgetMs = 0;
  let totalMs = 0;
  let previousEnd = -Infinity;

  for (const group of groups) {
    const limit = options.durationMs ?? Infinity;
    const start = Math.max(0, previousEnd, group.start - padMs);
    const end = Math.min(limit, group.end + padMs);
    if (end <= start) continue;

    const span = end - start;
    if (span < minWindowMs) {
      skippedAsTooShortMs += group.end - group.start;
      continue;
    }

    // Split evenly rather than into "max, max, remainder": three 10 s windows
    // transcribe and align better than 28 s + 28 s + 4 s.
    const parts = Math.ceil(span / maxWindowMs);
    const partMs = span / parts;
    for (let part = 0; part < parts; part++) {
      const partStart = Math.round(start + part * partMs);
      const partEnd =
        part === parts - 1 ? Math.round(end) : Math.round(start + (part + 1) * partMs);
      const duration = partEnd - partStart;
      if (duration <= 0) continue;

      if (totalMs + duration > maxTotalMs) {
        skippedForBudgetMs += duration;
        continue;
      }
      totalMs += duration;
      windows.push({
        start: partStart,
        end: partEnd,
        regionIndices: [...group.regionIndices],
        continuation: part > 0,
      });
      previousEnd = partEnd;
    }
  }

  return { windows, totalMs, skippedForBudgetMs, skippedAsTooShortMs };
}

/** Extracts a window's samples from a mono buffer, without copying. */
export function sliceWindow(
  mono: Float32Array,
  sampleRate: number,
  window: TimeRange,
): Float32Array {
  const from = Math.max(0, Math.floor((window.start / 1000) * sampleRate));
  const to = Math.min(mono.length, Math.ceil((window.end / 1000) * sampleRate));
  if (to <= from) return new Float32Array(0);
  return mono.subarray(from, to);
}
