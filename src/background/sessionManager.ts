/**
 * Per-tab analysis session.
 *
 * Holds the evidence timeline, the character registry and the scene builder for
 * one tab, and rebuilds the screenplay on a cadence the UI can actually read.
 *
 * Rebuild cadence is a deliberate product decision: the temporal engine updates
 * internally ten times a second, but the screenplay redraws roughly once a
 * second and only promotes settled scenes. Text that reflows every 100 ms is
 * unreadable, and the whole point of the stabilization window is that a beat
 * gets a chance to be revised before it stops moving.
 */

import { EvidenceTimeline } from '../evidence/timeline';
import type { EvidenceEvent, EvidenceSourceStatus, SourceStateMap } from '../evidence/types';
import { createSourceStateMap } from '../evidence/types';
import { CharacterRegistry } from '../characters/entities';
import { SceneBuilder } from '../scenes/builder';
import type { ReconstructedScene } from '../scenes/types';
import type { AnalysisFidelity } from '../temporal/fidelity';
import type {
  AnalysisPhase,
  AnalysisStatus,
  ContentIdentity,
  PlayerState,
  QualityStatus,
  SubtitleLanguage,
} from '../messaging/protocol';
import type { MediaTimeMs, TimeRange } from '../utils/time';
import { debounce } from '../utils/lifecycle';

export interface SessionOptions {
  tabId: number;
  fidelity: AnalysisFidelity;
  includeLowConfidence: boolean;
  /** Called whenever the scene model changed enough to redraw. */
  onScenesUpdated: (scenes: ReconstructedScene[], session: AnalysisSession) => void;
  /** Milliseconds between screenplay rebuilds. */
  rebuildIntervalMs?: number;
}

export class AnalysisSession {
  readonly tabId: number;
  readonly timeline = new EvidenceTimeline();
  readonly registry = new CharacterRegistry();

  #builder: SceneBuilder;
  #options: SessionOptions;
  #phase: AnalysisPhase = 'idle';
  #fidelity: AnalysisFidelity;
  #sources: SourceStateMap = createSourceStateMap();
  #identity: ContentIdentity | null = null;
  #player: PlayerState | null = null;
  #quality: QualityStatus | null = null;
  #subtitleLanguages: SubtitleLanguage[] = [];
  #userAssignments = new Map<string, string>();
  #errorMessage: string | undefined;

  #observedFps = 0;
  #deepRequests = 0;
  #lastDeepSampleAt = 0;
  #deepPerMinute = 0;

  #rebuild: ReturnType<typeof debounce<[]>>;
  #rebuildTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionOptions) {
    this.tabId = options.tabId;
    this.#options = options;
    this.#fidelity = options.fidelity;
    this.#builder = new SceneBuilder({
      registry: this.registry,
      includeLowConfidence: options.includeLowConfidence,
      userAssignments: this.#userAssignments,
    });

    // Coalesce bursts of evidence; the offscreen batcher can deliver 100+
    // events at once and each must not trigger its own rebuild.
    this.#rebuild = debounce(() => this.#doRebuild(), 300);
  }

  get phase(): AnalysisPhase {
    return this.#phase;
  }

  get identity(): ContentIdentity | null {
    return this.#identity;
  }

  get player(): PlayerState | null {
    return this.#player;
  }

  get quality(): QualityStatus | null {
    return this.#quality;
  }

  get subtitleLanguages(): SubtitleLanguage[] {
    return this.#subtitleLanguages;
  }

  get scenes(): ReconstructedScene[] {
    return this.#builder.scenes;
  }

  get currentTime(): MediaTimeMs {
    return this.#player?.currentTimeMs ?? 0;
  }

  setPhase(phase: AnalysisPhase, errorMessage?: string): void {
    this.#phase = phase;
    this.#errorMessage = errorMessage;
    if (phase === 'running') this.#startRebuildTimer();
    else this.#stopRebuildTimer();
  }

  setFidelity(fidelity: AnalysisFidelity): void {
    this.#fidelity = fidelity;
  }

  setIdentity(identity: ContentIdentity | null): void {
    const changed = identity?.contentId !== this.#identity?.contentId;
    this.#identity = identity;
    if (changed) {
      // New content is a new screenplay. Carrying scenes across would attach
      // one episode's dialogue to another's.
      this.timeline.clear();
      this.registry.clear();
      this.#builder.reset();
      this.#userAssignments.clear();
    }
    if (identity?.durationMs) this.timeline.setDuration(identity.durationMs);
  }

  setPlayerState(state: PlayerState): void {
    this.#player = state;
    if (state.durationMs) this.timeline.setDuration(state.durationMs);
  }

  setQuality(quality: QualityStatus): void {
    this.#quality = quality;
  }

  setSubtitleLanguages(languages: SubtitleLanguage[]): void {
    this.#subtitleLanguages = languages;
  }

  setSourceStatuses(statuses: readonly EvidenceSourceStatus[]): void {
    for (const status of statuses) {
      const existing = this.#sources[status.id];
      this.#sources[status.id] = { ...existing, ...status, eventCount: existing.eventCount };
      this.timeline.setSourceState(status.id, status.state, status.message);
    }
  }

  setStats(stats: { observedFps: number; deepRequests: number }): void {
    this.#observedFps = stats.observedFps;
    const now = Date.now();
    if (this.#lastDeepSampleAt > 0) {
      const elapsedMinutes = (now - this.#lastDeepSampleAt) / 60_000;
      const delta = stats.deepRequests - this.#deepRequests;
      if (elapsedMinutes > 0) this.#deepPerMinute = Math.round(delta / elapsedMinutes);
    }
    this.#deepRequests = stats.deepRequests;
    this.#lastDeepSampleAt = now;
  }

  /**
   * Ingests evidence.
   *
   * Coverage is marked from the events themselves, so the coverage report
   * reflects what was actually observed rather than how long analysis ran.
   */
  ingest(events: readonly EvidenceEvent[]): void {
    for (const event of events) {
      const { added } = this.timeline.append(event);
      if (!added) continue;

      const end = event.end ?? event.start;
      if (end > event.start) this.timeline.markObserved(event.start, end);
      else this.timeline.markObserved(event.start, event.start + 100);

      // A seek discontinues the scene builder's assumptions about continuity.
      if (event.source === 'playback' && event.payload.kind === 'seek') {
        this.#builder.handleSeek(event.start);
      }
    }
    this.#rebuild();
  }

  // --- User corrections -------------------------------------------------------

  /**
   * Assigns a speaker to a dialogue beat.
   *
   * `forward` applies the correction to every later beat currently attributed
   * to the same voice cluster, which is what a viewer means when they name a
   * character partway through a scene.
   */
  assignSpeaker(beatId: string, characterId: string, scope: 'single' | 'forward'): void {
    const beat = this.#findDialogueBeat(beatId);
    if (!beat) return;

    for (const evidenceId of beat.provenance.evidenceIds) {
      this.#userAssignments.set(evidenceId, characterId);
    }

    if (scope === 'forward') {
      const previousCharacterId = beat.characterId;
      if (previousCharacterId && previousCharacterId !== characterId) {
        for (const scene of this.scenes) {
          for (const later of scene.beats) {
            if (later.type !== 'dialogue' || later.start < beat.start) continue;
            if (later.characterId !== previousCharacterId) continue;
            for (const evidenceId of later.provenance.evidenceIds) {
              this.#userAssignments.set(evidenceId, characterId);
            }
          }
        }
      }
    }
    this.#builder.setUserAssignments(this.#userAssignments);
    this.#doRebuild();
  }

  renameCharacter(characterId: string, name: string): void {
    this.registry.rename(characterId, name);
    this.#doRebuild();
  }

  mergeCharacters(targetId: string, sourceId: string): void {
    this.registry.merge(targetId, sourceId);
    this.#doRebuild();
  }

  splitSpeaker(characterId: string, speakerId: string): void {
    this.registry.split(characterId, speakerId, this.currentTime);
    this.#doRebuild();
  }

  // --- Status -----------------------------------------------------------------

  status(): AnalysisStatus {
    const coverageRatio = this.timeline.coverageRatio();
    const uncovered = this.timeline.uncoveredRanges();
    return {
      phase: this.#phase,
      tabId: this.tabId,
      fidelity: this.#fidelity,
      sources: this.#sources,
      observedFps: this.#observedFps,
      deepAnalysisPerMinute: this.#deepPerMinute,
      ...(coverageRatio === undefined ? {} : { coverageRatio }),
      ...(uncovered.length > 0 ? { uncovered: uncovered as TimeRange[] } : {}),
      ...(this.#errorMessage ? { errorMessage: this.#errorMessage } : {}),
    };
  }

  dispose(): void {
    this.#stopRebuildTimer();
    this.#rebuild.cancel();
    this.timeline.clear();
    this.registry.clear();
    this.#builder.reset();
  }

  // --- internals ---------------------------------------------------------------

  #findDialogueBeat(beatId: string) {
    for (const scene of this.scenes) {
      for (const beat of scene.beats) {
        if (beat.id === beatId && beat.type === 'dialogue') return beat;
      }
    }
    return null;
  }

  /**
   * A periodic rebuild in addition to the evidence-driven one, so that scenes
   * finalize as playback moves on even during a long silent stretch with no new
   * evidence arriving.
   */
  #startRebuildTimer(): void {
    if (this.#rebuildTimer !== null) return;
    this.#rebuildTimer = setInterval(() => this.#doRebuild(), this.#options.rebuildIntervalMs ?? 1_000);
  }

  #stopRebuildTimer(): void {
    if (this.#rebuildTimer === null) return;
    clearInterval(this.#rebuildTimer);
    this.#rebuildTimer = null;
  }

  #doRebuild(): void {
    const result = this.#builder.rebuild(this.timeline, this.currentTime);
    this.#options.onScenesUpdated(result.scenes, this);
  }
}

/** Registry of live sessions, one per tab. */
export class SessionManager {
  #sessions = new Map<number, AnalysisSession>();

  get(tabId: number): AnalysisSession | undefined {
    return this.#sessions.get(tabId);
  }

  ensure(tabId: number, factory: () => AnalysisSession): AnalysisSession {
    const existing = this.#sessions.get(tabId);
    if (existing) return existing;
    const created = factory();
    this.#sessions.set(tabId, created);
    return created;
  }

  remove(tabId: number): void {
    const session = this.#sessions.get(tabId);
    if (!session) return;
    session.dispose();
    this.#sessions.delete(tabId);
  }

  get activeCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (session.phase === 'running') count++;
    }
    return count;
  }

  all(): AnalysisSession[] {
    return [...this.#sessions.values()];
  }

  clear(): void {
    for (const tabId of [...this.#sessions.keys()]) this.remove(tabId);
  }
}
