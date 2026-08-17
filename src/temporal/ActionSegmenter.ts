/**
 * Action segmentation.
 *
 * This is the layer that stops FrameScript reading like a CCTV log.
 *
 * The scanner sees "arm moves / hand nears handle / door edge shifts" as six
 * separate 100 ms observations. Screenplays do not want six lines; they want
 * "He reaches for the handle and opens it." The segmenter groups contiguous
 * temporal events into one *action segment* — and, crucially, records the
 * micro-structure inside it (notably hesitations), so that when a pause is
 * narratively meaningful the screenplay can keep it.
 *
 * Layer position:
 *   raw observation -> temporal event -> ACTION SEGMENT -> scene beat -> screenplay
 */

import { createIdFactory } from '../utils/id';
import type { MediaTimeMs, TimeRange } from '../utils/time';
import type { ConfidenceLevel, TemporalVisualEvent } from '../evidence/types';
import { fromScore } from '../evidence/confidence';

export interface ActionSegment {
  id: string;
  start: MediaTimeMs;
  end: MediaTimeMs;
  /** Timestamps of the temporal events that constitute this segment. */
  eventTimestamps: MediaTimeMs[];
  /** Ids of characters believed present, filled in later by the scene engine. */
  participantIds: string[];
  peakImportance: number;
  meanMotion: number;
  /** True when the segment opens on a detected scene cut. */
  startsOnCut: boolean;
  /**
   * Pauses inside sustained motion. A 300 ms stillness between two bursts of
   * movement is exactly the "reaches out, hesitates, pulls back" beat that
   * dense temporal observation exists to catch.
   */
  hesitations: TimeRange[];
  /** Set by the vision layer when a provider described the segment. */
  semanticDescription?: string;
  confidence: ConfidenceLevel;
}

export interface ActionSegmenterOptions {
  /** Gap in temporal events that closes the current segment. */
  maxGapMs?: number;
  /** Hard cap on a single action segment. */
  maxDurationMs?: number;
  /** Importance below which an event does not sustain a segment. */
  sustainThreshold?: number;
  /** Importance required to open a new segment. */
  openThreshold?: number;
  /** Minimum stillness inside a segment to be reported as a hesitation. */
  minHesitationMs?: number;
  /** Motion at or below this counts as stillness. */
  hesitationMotionCeiling?: number;
}

const SEGMENTER_DEFAULTS: Required<ActionSegmenterOptions> = {
  maxGapMs: 700,
  maxDurationMs: 8_000,
  sustainThreshold: 0.1,
  openThreshold: 0.18,
  minHesitationMs: 250,
  hesitationMotionCeiling: 0.06,
};

interface OpenSegment {
  start: MediaTimeMs;
  end: MediaTimeMs;
  events: TemporalVisualEvent[];
  startsOnCut: boolean;
}

export class ActionSegmenter {
  #options: Required<ActionSegmenterOptions>;
  #nextId = createIdFactory('action');
  #open: OpenSegment | null = null;
  #completed: ActionSegment[] = [];

  constructor(options: ActionSegmenterOptions = {}) {
    this.#options = { ...SEGMENTER_DEFAULTS, ...options };
  }

  get completed(): readonly ActionSegment[] {
    return this.#completed;
  }

  /** True while a segment is still accumulating events. */
  get hasOpenSegment(): boolean {
    return this.#open !== null;
  }

  /**
   * Feeds one temporal event. Returns a segment when this event closed one.
   */
  push(event: TemporalVisualEvent): ActionSegment | null {
    const isCut = (event.metrics.sceneCutScore ?? 0) >= 0.6;
    let closed: ActionSegment | null = null;

    if (this.#open) {
      const gap = event.timestamp - this.#open.end;
      const duration = event.timestamp - this.#open.start;
      // A cut always ends the current action: the next shot is a new action.
      if (isCut || gap > this.#options.maxGapMs || duration > this.#options.maxDurationMs) {
        closed = this.#close();
      }
    }

    if (!this.#open) {
      if (event.importance >= this.#options.openThreshold || isCut) {
        this.#open = { start: event.timestamp, end: event.timestamp, events: [event], startsOnCut: isCut };
      }
      return closed;
    }

    // Every event inside an open segment is recorded, including low-importance
    // ones. Those low-importance observations ARE the hesitation: dropping them
    // would discard exactly the stillness that "reaches out, hesitates, pulls
    // back" is made of. Only a sustaining event advances the segment's end, so
    // a genuine lull still closes the segment via the gap check above.
    this.#open.events.push(event);
    if (event.importance >= this.#options.sustainThreshold) {
      this.#open.end = event.timestamp;
    }
    return closed;
  }

  /** Closes any open segment. Call at scene end, on seek, or at stop. */
  flush(): ActionSegment | null {
    return this.#close();
  }

  #close(): ActionSegment | null {
    const open = this.#open;
    this.#open = null;
    if (!open || open.events.length === 0) return null;

    const importances = open.events.map((e) => e.importance);
    const motions = open.events.map((e) => e.metrics.motionScore ?? 0);
    const peakImportance = Math.max(...importances);
    const meanMotion = motions.reduce((s, v) => s + v, 0) / motions.length;

    const segment: ActionSegment = {
      id: this.#nextId(),
      start: open.start,
      // A single-observation segment still occupies the sampling interval.
      end: Math.max(open.end, open.start + 100),
      eventTimestamps: open.events.map((e) => e.timestamp),
      participantIds: [],
      peakImportance,
      meanMotion,
      startsOnCut: open.startsOnCut,
      hesitations: findHesitations(open.events, this.#options),
      // A local heuristic alone never earns better than medium.
      confidence: fromScore(peakImportance),
    };
    this.#completed.push(segment);
    return segment;
  }

  reset(): void {
    this.#open = null;
    this.#completed = [];
  }
}

/**
 * Finds stillness sandwiched between motion.
 *
 * Requires motion on *both* sides: a trailing pause is just the end of the
 * action, whereas a pause between two movements is a hesitation, and only the
 * latter is worth a screenplay clause.
 */
export function findHesitations(
  events: readonly TemporalVisualEvent[],
  options: Pick<Required<ActionSegmenterOptions>, 'minHesitationMs' | 'hesitationMotionCeiling'>,
): TimeRange[] {
  if (events.length < 3) return [];
  const out: TimeRange[] = [];
  let stillStart: MediaTimeMs | null = null;
  let sawMotionBefore = false;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const motion = event.metrics.motionScore ?? 0;
    const still = motion <= options.hesitationMotionCeiling;

    if (still) {
      if (stillStart === null) stillStart = event.timestamp;
    } else {
      if (stillStart !== null && sawMotionBefore) {
        const duration = event.timestamp - stillStart;
        if (duration >= options.minHesitationMs) out.push({ start: stillStart, end: event.timestamp });
      }
      stillStart = null;
      sawMotionBefore = true;
    }
  }
  return out;
}

/**
 * Merges adjacent segments that describe one continuous action.
 *
 * Applied before prose generation so that a brief dip below the sustain
 * threshold — someone pausing mid-stride — does not become two sentences.
 */
export function mergeAdjacentSegments(
  segments: readonly ActionSegment[],
  maxGapMs = 400,
): ActionSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: ActionSegment[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    const current = out[out.length - 1]!;
    if (!next.startsOnCut && next.start - current.end <= maxGapMs) {
      const gap: TimeRange | null =
        next.start - current.end >= 250 ? { start: current.end, end: next.start } : null;
      out[out.length - 1] = {
        ...current,
        end: next.end,
        eventTimestamps: [...current.eventTimestamps, ...next.eventTimestamps],
        peakImportance: Math.max(current.peakImportance, next.peakImportance),
        meanMotion: (current.meanMotion + next.meanMotion) / 2,
        hesitations: [...current.hesitations, ...(gap ? [gap] : []), ...next.hesitations],
        confidence: current.confidence,
      };
    } else {
      out.push({ ...next });
    }
  }
  return out;
}
