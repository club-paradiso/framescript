/**
 * Evidence windows.
 *
 * Fusion never looks at a single event in isolation — a subtitle means one
 * thing next to a door-slam and another next to a scene cut. A window gathers
 * every source's view of one slice of media time.
 *
 * Window boundaries are adaptive: dense dialogue produces short windows, a
 * static wide shot produces long ones. This keeps the number of deep-analysis
 * requests proportional to how much is actually happening.
 */

import { rangesOverlap, type TimeRange } from '../utils/time';
import type { MediaTimeMs } from '../utils/time';
import type {
  EvidenceEvent,
  OcrEvidence,
  PlaybackEvidence,
  SilenceEvidence,
  SoundEvidence,
  SpeakerEvidence,
  SpeechEvidence,
  SubtitleEvidence,
  VisualEvidence,
} from './types';

export interface EvidenceWindow {
  start: MediaTimeMs;
  end: MediaTimeMs;
  subtitles: SubtitleEvidence[];
  speech: SpeechEvidence[];
  speakers: SpeakerEvidence[];
  soundEvents: SoundEvidence[];
  silences: SilenceEvidence[];
  visualEvents: VisualEvidence[];
  ocrEvents: OcrEvidence[];
  playbackEvents: PlaybackEvidence[];
  /** Highest importance among the visual events, for scheduling deep analysis. */
  peakImportance: number;
}

export interface WindowingOptions {
  /** Shortest window we will emit. Below this, dialogue fragments. */
  minDurationMs?: number;
  /** Longest window before we force a cut even in a static shot. */
  maxDurationMs?: number;
  /** Preferred window length in ordinary material. */
  targetDurationMs?: number;
  /** Gap in dialogue that is allowed to end a window early. */
  dialogueGapMs?: number;
}

const WINDOW_DEFAULTS: Required<WindowingOptions> = {
  minDurationMs: 800,
  maxDurationMs: 12_000,
  targetDurationMs: 4_000,
  dialogueGapMs: 700,
};

export function emptyWindow(start: MediaTimeMs, end: MediaTimeMs): EvidenceWindow {
  return {
    start,
    end,
    subtitles: [],
    speech: [],
    speakers: [],
    soundEvents: [],
    silences: [],
    visualEvents: [],
    ocrEvents: [],
    playbackEvents: [],
    peakImportance: 0,
  };
}

/** Places one event into a window's typed bucket. */
export function addToWindow(window: EvidenceWindow, event: EvidenceEvent): void {
  switch (event.source) {
    case 'subtitle':
      window.subtitles.push(event);
      break;
    case 'audio-asr':
      window.speech.push(event);
      break;
    case 'audio-speaker':
      window.speakers.push(event);
      break;
    case 'audio-event':
      window.soundEvents.push(event);
      break;
    case 'audio-silence':
      window.silences.push(event);
      break;
    case 'video':
      window.visualEvents.push(event);
      break;
    case 'ocr':
      window.ocrEvents.push(event);
      break;
    case 'playback':
      window.playbackEvents.push(event);
      break;
    // metadata and user evidence are consumed by dedicated engines, not windows
    case 'metadata':
    case 'user':
      break;
  }
}

export function windowIsEmpty(window: EvidenceWindow): boolean {
  return (
    window.subtitles.length === 0 &&
    window.speech.length === 0 &&
    window.speakers.length === 0 &&
    window.soundEvents.length === 0 &&
    window.silences.length === 0 &&
    window.visualEvents.length === 0 &&
    window.ocrEvents.length === 0 &&
    window.playbackEvents.length === 0
  );
}

/**
 * Builds windows over a span of evidence.
 *
 * Cut points, in priority order:
 *   1. a scene-change visual event (a cut is always a window boundary),
 *   2. a seek (evidence either side is not continuous),
 *   3. a dialogue gap once the window is at least `targetDurationMs`,
 *   4. `maxDurationMs` as a hard stop.
 */
export function buildEvidenceWindows(
  events: readonly EvidenceEvent[],
  span: TimeRange,
  options: WindowingOptions = {},
): EvidenceWindow[] {
  const opts = { ...WINDOW_DEFAULTS, ...options };
  const sorted = [...events].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const cuts = collectCutPoints(sorted, span, opts);
  const windows: EvidenceWindow[] = [];

  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    const window = emptyWindow(start, end);
    for (const event of sorted) {
      const eventRange: TimeRange = { start: event.start, end: event.end ?? event.start + 1 };
      if (rangesOverlap(eventRange, { start, end })) addToWindow(window, event);
    }
    window.peakImportance = window.visualEvents.reduce(
      (peak, v) => Math.max(peak, v.payload.metrics?.sceneCutScore ?? 0),
      0,
    );
    if (!windowIsEmpty(window)) windows.push(window);
  }
  return windows;
}

function collectCutPoints(
  sorted: readonly EvidenceEvent[],
  span: TimeRange,
  opts: Required<WindowingOptions>,
): MediaTimeMs[] {
  const hard = new Set<MediaTimeMs>([span.start, span.end]);

  for (const event of sorted) {
    if (event.source === 'video' && event.payload.kind === 'scene-change') hard.add(event.start);
    if (event.source === 'playback' && event.payload.kind === 'seek') hard.add(event.start);
  }

  const ordered = [...hard].filter((t) => t >= span.start && t <= span.end).sort((a, b) => a - b);
  const out: MediaTimeMs[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i]!;
    out.push(start);
    const next = ordered[i + 1];
    if (next === undefined) continue;
    // Subdivide long stretches between hard cuts.
    let cursor = start;
    while (next - cursor > opts.maxDurationMs) {
      const candidate = findDialogueGap(sorted, cursor + opts.targetDurationMs, next, opts) ??
        cursor + opts.targetDurationMs;
      const bounded = Math.min(Math.max(candidate, cursor + opts.minDurationMs), next - opts.minDurationMs);
      if (bounded <= cursor) break;
      out.push(bounded);
      cursor = bounded;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Finds a quiet moment to cut on, so windows do not split mid-sentence.
 * Returns undefined when dialogue is continuous throughout the search span.
 */
function findDialogueGap(
  events: readonly EvidenceEvent[],
  from: MediaTimeMs,
  to: MediaTimeMs,
  opts: Required<WindowingOptions>,
): MediaTimeMs | undefined {
  const spoken = events
    .filter((e) => e.source === 'subtitle' || e.source === 'audio-asr')
    .map((e) => ({ start: e.start, end: e.end ?? e.start + 500 }))
    .sort((a, b) => a.start - b.start);

  let cursor = from;
  for (const s of spoken) {
    if (s.end <= from) continue;
    if (s.start >= to) break;
    if (s.start - cursor >= opts.dialogueGapMs) return cursor + Math.floor((s.start - cursor) / 2);
    cursor = Math.max(cursor, s.end);
  }
  return cursor > from && cursor < to ? cursor : undefined;
}
