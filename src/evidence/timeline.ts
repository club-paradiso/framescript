/**
 * The evidence timeline — FrameScript's single source of truth.
 *
 * Sources append here; the scene engine reads from here. Nothing bypasses it.
 * The timeline is responsible for:
 *   - keeping events ordered by media time,
 *   - deduplicating repeats (players re-render the same subtitle constantly),
 *   - tracking which parts of the media were actually observed,
 *   - staying bounded in memory.
 */

import { coveredDuration, invertRanges, mergeRanges, type TimeRange } from '../utils/time';
import type { MediaTimeMs } from '../utils/time';
import { comparableText } from '../utils/text';
import type {
  EvidenceEvent,
  EvidenceSourceId,
  SourceStateMap,
  EvidenceSourceState,
} from './types';
import { createSourceStateMap } from './types';

export interface CoverageMap {
  /** Ranges of media time in which at least one source was observing. */
  observed: TimeRange[];
  /** Known media duration, when the player reported one. */
  durationMs?: number;
}

export interface TimelineOptions {
  /**
   * Hard cap on retained events. Long films at Forensic fidelity can generate
   * a great many low-value events; when the cap is hit the timeline evicts the
   * *least informative* events rather than the oldest, so the screenplay keeps
   * its structure.
   */
  maxEvents?: number;
  /** Window within which identical events from one source are treated as one. */
  dedupeWindowMs?: number;
}

export type TimelineListener = (event: EvidenceEvent) => void;

const DEFAULTS = { maxEvents: 60_000, dedupeWindowMs: 1_500 } as const;

export class EvidenceTimeline {
  #events: EvidenceEvent[] = [];
  #byId = new Map<string, EvidenceEvent>();
  /** source -> normalized payload key -> last event start, for deduplication. */
  #recentKeys = new Map<string, MediaTimeMs>();
  #sources: SourceStateMap = createSourceStateMap();
  #coverage: TimeRange[] = [];
  #durationMs: number | undefined;
  #listeners = new Set<TimelineListener>();
  #options: Required<TimelineOptions>;
  #sorted = true;
  #evictedCount = 0;

  constructor(options: TimelineOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get size(): number {
    return this.#events.length;
  }

  get evictedCount(): number {
    return this.#evictedCount;
  }

  get sources(): SourceStateMap {
    return this.#sources;
  }

  setDuration(ms: number | undefined): void {
    this.#durationMs = ms && ms > 0 ? ms : undefined;
  }

  get durationMs(): number | undefined {
    return this.#durationMs;
  }

  subscribe(listener: TimelineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setSourceState(id: EvidenceSourceId, state: EvidenceSourceState, message?: string): void {
    const existing = this.#sources[id];
    this.#sources[id] = {
      ...existing,
      state,
      ...(message === undefined ? {} : { message }),
    };
  }

  /**
   * Appends an event.
   *
   * Returns the stored event, which may be an *existing* event when the
   * incoming one is a duplicate — callers use the identity to decide whether
   * anything actually changed.
   */
  append(event: EvidenceEvent): { event: EvidenceEvent; added: boolean } {
    const existingById = this.#byId.get(event.id);
    if (existingById) {
      // Same id re-appended: treat as an update (used for provisional -> final).
      Object.assign(existingById, event);
      this.#notify(existingById);
      return { event: existingById, added: false };
    }

    const key = dedupeKey(event);
    if (key) {
      const lastAt = this.#recentKeys.get(key);
      if (lastAt !== undefined && Math.abs(event.start - lastAt) <= this.#options.dedupeWindowMs) {
        const prior = this.#findRecentMatch(key, event);
        if (prior) {
          // Extend the earlier event rather than storing a near-identical twin.
          prior.end = Math.max(prior.end ?? prior.start, event.end ?? event.start);
          return { event: prior, added: false };
        }
      }
      this.#recentKeys.set(key, event.start);
    }

    this.#events.push(event);
    this.#byId.set(event.id, event);
    this.#sorted = this.#sorted && this.#isTailOrdered();

    const status = this.#sources[event.source];
    this.#sources[event.source] = {
      ...status,
      state: status.state === 'active' ? 'active' : 'active',
      eventCount: status.eventCount + 1,
      lastEventAt: event.start,
    };

    if (this.#events.length > this.#options.maxEvents) this.#evict();
    this.#notify(event);
    return { event, added: true };
  }

  appendAll(events: readonly EvidenceEvent[]): void {
    for (const e of events) this.append(e);
  }

  get(id: string): EvidenceEvent | undefined {
    return this.#byId.get(id);
  }

  getMany(ids: readonly string[]): EvidenceEvent[] {
    const out: EvidenceEvent[] = [];
    for (const id of ids) {
      const e = this.#byId.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /** All events, ordered by start then by source id for stable ties. */
  all(): readonly EvidenceEvent[] {
    this.#ensureSorted();
    return this.#events;
  }

  /** Events overlapping `[start, end)`. */
  range(start: MediaTimeMs, end: MediaTimeMs): EvidenceEvent[] {
    this.#ensureSorted();
    return this.#events.filter((e) => {
      const eEnd = e.end ?? e.start;
      return e.start < end && eEnd >= start;
    });
  }

  bySource<T extends EvidenceEvent>(source: EvidenceSourceId): T[] {
    this.#ensureSorted();
    return this.#events.filter((e): e is T => e.source === source);
  }

  /** Marks `[start, end)` as observed by at least one source. */
  markObserved(start: MediaTimeMs, end: MediaTimeMs): void {
    if (end <= start) return;
    this.#coverage.push({ start, end });
    // Merge lazily but often enough that the array cannot grow without bound.
    if (this.#coverage.length > 512) this.#coverage = mergeRanges(this.#coverage, 250);
  }

  coverage(): CoverageMap {
    this.#coverage = mergeRanges(this.#coverage, 250);
    const map: CoverageMap = { observed: [...this.#coverage] };
    if (this.#durationMs !== undefined) map.durationMs = this.#durationMs;
    return map;
  }

  /** Fraction of the media that was actually observed, in [0,1]. */
  coverageRatio(): number | undefined {
    if (!this.#durationMs) return undefined;
    return Math.min(1, coveredDuration(this.#coverage) / this.#durationMs);
  }

  /** Ranges that were never observed — shown as gaps, never invented. */
  uncoveredRanges(): TimeRange[] {
    if (!this.#durationMs) return [];
    return invertRanges(this.#coverage, this.#durationMs);
  }

  clear(): void {
    this.#events = [];
    this.#byId.clear();
    this.#recentKeys.clear();
    this.#coverage = [];
    this.#sources = createSourceStateMap();
    this.#evictedCount = 0;
    this.#sorted = true;
  }

  // --- internals ------------------------------------------------------------

  #notify(event: EvidenceEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[FrameScript] timeline listener threw', err);
      }
    }
  }

  #isTailOrdered(): boolean {
    const n = this.#events.length;
    if (n < 2) return true;
    return this.#events[n - 2]!.start <= this.#events[n - 1]!.start;
  }

  #ensureSorted(): void {
    if (this.#sorted) return;
    this.#events.sort((a, b) => a.start - b.start || a.source.localeCompare(b.source));
    this.#sorted = true;
  }

  #findRecentMatch(key: string, event: EvidenceEvent): EvidenceEvent | undefined {
    // Scan backwards over the dedupe window only — bounded work per append.
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const candidate = this.#events[i]!;
      if (event.start - candidate.start > this.#options.dedupeWindowMs) break;
      if (dedupeKey(candidate) === key) return candidate;
    }
    return undefined;
  }

  /**
   * Evicts the least informative 10% of events.
   *
   * Priority order for keeping: user corrections > metadata > subtitles/ASR >
   * everything else, with confidence as the tiebreaker. Dialogue and user input
   * are never the first thing dropped.
   */
  #evict(): void {
    this.#ensureSorted();
    const target = Math.floor(this.#options.maxEvents * 0.1);
    const scored = this.#events.map((e, index) => ({ e, index, score: retentionScore(e) }));
    scored.sort((a, b) => a.score - b.score || a.index - b.index);
    const doomed = new Set(scored.slice(0, target).map((s) => s.e.id));
    this.#events = this.#events.filter((e) => !doomed.has(e.id));
    for (const id of doomed) this.#byId.delete(id);
    this.#evictedCount += doomed.size;
  }
}

const SOURCE_RETENTION: Record<EvidenceSourceId, number> = {
  user: 100,
  metadata: 90,
  subtitle: 80,
  'audio-asr': 75,
  ocr: 60,
  'audio-speaker': 55,
  'audio-event': 45,
  video: 40,
  playback: 35,
  'audio-silence': 20,
};

const CONFIDENCE_BONUS = { high: 6, medium: 4, low: 2, unknown: 0 } as const;

function retentionScore(event: EvidenceEvent): number {
  return SOURCE_RETENTION[event.source] + CONFIDENCE_BONUS[event.confidence];
}

/**
 * Key identifying "the same observation again".
 *
 * Only sources that genuinely repeat get a key. Video temporal events, for
 * instance, are intentionally not deduplicated by payload because two identical
 * metric readings at different times are two real observations.
 */
function dedupeKey(event: EvidenceEvent): string | null {
  switch (event.source) {
    case 'subtitle':
      return `subtitle|${event.payload.language}|${comparableText(event.payload.text)}`;
    case 'audio-asr':
      return `asr|${comparableText(event.payload.text)}`;
    case 'ocr':
      return `ocr|${comparableText(event.payload.text)}`;
    case 'audio-event':
      return `sound|${event.payload.kind}`;
    case 'metadata':
      return `meta|${event.payload.kind}|${event.payload.value}`;
    default:
      return null;
  }
}
