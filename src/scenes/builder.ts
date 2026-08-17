/**
 * The rolling scene builder.
 *
 * Screenplay reconstruction runs *while* the user watches, so this class never
 * waits for the end of the film. It maintains two regions:
 *
 *   - a FINALIZED prefix, which is immutable and safe to save and export;
 *   - a PROVISIONAL tail, which is recomputed from scratch on every rebuild.
 *
 * Recomputing the tail (rather than appending incrementally) is what makes
 * rewinding correct: replaying a section produces the same scenes rather than
 * duplicates, because the tail is derived from the timeline, and the timeline
 * already deduplicates. Beat ids are content-derived and therefore stable
 * across rebuilds, which is what keeps the side panel from flickering.
 */

import { shortHash } from '../utils/id';
import type { MediaTimeMs } from '../utils/time';
import { mergeProvenance, provenanceFrom } from '../evidence/provenance';
import { minConfidence } from '../evidence/confidence';
import type { EvidenceEvent, VisualEvidence } from '../evidence/types';
import type { EvidenceTimeline } from '../evidence/timeline';
import { buildEvidenceWindows } from '../evidence/windows';
import type { CharacterRegistry, SceneCharacterPresence } from '../characters/entities';
import { detectSceneBoundaries } from './boundaries';
import { fuseWindow, type FusionConflict } from './fusion';
import { compareBeats, type ReconstructedScene, type SceneBeat, type SceneSetting } from './types';

export interface SceneBuilderOptions {
  registry: CharacterRegistry;
  /**
   * How far behind playback a scene must be before it is finalized. Long enough
   * that late-arriving evidence (a slow ASR response) can still revise it.
   */
  stabilizationMs?: number;
  includeLowConfidence?: boolean;
  /** User speaker assignments, keyed by evidence id. */
  userAssignments?: Map<string, string>;
}

export interface BuildResult {
  scenes: ReconstructedScene[];
  conflicts: FusionConflict[];
  /** Scenes finalized by this rebuild. */
  newlyFinalized: ReconstructedScene[];
}

const DEFAULT_STABILIZATION_MS = 8_000;

export class SceneBuilder {
  #registry: CharacterRegistry;
  #stabilizationMs: number;
  #includeLowConfidence: boolean;
  #userAssignments: Map<string, string>;

  #finalized: ReconstructedScene[] = [];
  #finalizedUntil: MediaTimeMs = 0;
  #provisional: ReconstructedScene[] = [];
  #conflicts: FusionConflict[] = [];
  #lastCharacterId: string | undefined;

  constructor(options: SceneBuilderOptions) {
    this.#registry = options.registry;
    this.#stabilizationMs = options.stabilizationMs ?? DEFAULT_STABILIZATION_MS;
    this.#includeLowConfidence = options.includeLowConfidence ?? false;
    this.#userAssignments = options.userAssignments ?? new Map();
  }

  get scenes(): ReconstructedScene[] {
    return [...this.#finalized, ...this.#provisional];
  }

  get conflicts(): readonly FusionConflict[] {
    return this.#conflicts;
  }

  setUserAssignments(assignments: Map<string, string>): void {
    this.#userAssignments = assignments;
  }

  setIncludeLowConfidence(value: boolean): void {
    this.#includeLowConfidence = value;
  }

  /**
   * Recomputes the provisional tail from the timeline and promotes anything
   * that has settled.
   */
  rebuild(timeline: EvidenceTimeline, currentTime: MediaTimeMs): BuildResult {
    const duration = timeline.durationMs ?? currentTime;
    const tailStart = this.#finalizedUntil;
    const tailEnd = Math.max(currentTime, duration > 0 ? Math.min(duration, currentTime + 1) : currentTime);

    const events = timeline.all().filter((e) => (e.end ?? e.start) >= tailStart);
    const { scenes, conflicts } = this.#buildScenes(events, tailStart, Math.max(tailEnd, tailStart + 1));

    this.#provisional = scenes;
    this.#conflicts = conflicts;

    const newlyFinalized = this.#promoteStableScenes(currentTime);
    return { scenes: this.scenes, conflicts: this.#conflicts, newlyFinalized };
  }

  /**
   * Handles a seek.
   *
   * Nothing is invented for the skipped range: the timeline simply has no
   * coverage there, and the coverage report says so. Seeking *backwards* into
   * analyzed material is handled by the ordinary rebuild path, which reuses
   * existing evidence rather than creating a second copy of the scene.
   */
  handleSeek(to: MediaTimeMs): void {
    if (to < this.#finalizedUntil) {
      // Re-open finalized scenes that the viewer has jumped back into, so new
      // evidence can revise them instead of being appended to a duplicate.
      const reopened = this.#finalized.filter((s) => (s.end ?? s.start) >= to);
      this.#finalized = this.#finalized.filter((s) => (s.end ?? s.start) < to);
      this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
      for (const scene of reopened) scene.status = 'provisional';
    }
    this.#lastCharacterId = undefined;
  }

  reset(): void {
    this.#finalized = [];
    this.#provisional = [];
    this.#conflicts = [];
    this.#finalizedUntil = 0;
    this.#lastCharacterId = undefined;
  }

  /** Restores previously saved scenes, e.g. when reopening a saved screenplay. */
  restore(scenes: readonly ReconstructedScene[]): void {
    this.#finalized = scenes.filter((s) => s.status === 'finalized').map((s) => ({ ...s }));
    this.#provisional = scenes.filter((s) => s.status !== 'finalized').map((s) => ({ ...s }));
    this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
  }

  #buildScenes(
    events: readonly EvidenceEvent[],
    spanStart: MediaTimeMs,
    spanEnd: MediaTimeMs,
  ): { scenes: ReconstructedScene[]; conflicts: FusionConflict[] } {
    if (events.length === 0) return { scenes: [], conflicts: [] };

    const boundaries = detectSceneBoundaries(events);
    const cuts = [spanStart, ...boundaries.map((b) => b.timestamp), spanEnd]
      .filter((t) => t >= spanStart && t <= spanEnd)
      .sort((a, b) => a - b);
    const uniqueCuts = [...new Set(cuts)];

    const scenes: ReconstructedScene[] = [];
    const conflicts: FusionConflict[] = [];
    let previousCharacterId = this.#lastCharacterId;

    for (let i = 0; i < uniqueCuts.length - 1; i++) {
      const start = uniqueCuts[i]!;
      const end = uniqueCuts[i + 1]!;
      const sceneEvents = events.filter((e) => e.start >= start && e.start < end);
      if (sceneEvents.length === 0) continue;

      const windows = buildEvidenceWindows(sceneEvents, { start, end });
      const beats: SceneBeat[] = [];
      const presentCharacterIds = new Set<string>();

      for (const window of windows) {
        const result = fuseWindow(window, {
          registry: this.#registry,
          ...(previousCharacterId ? { previousCharacterId } : {}),
          presentCharacterIds: [...presentCharacterIds],
          userAssignments: this.#userAssignments,
          includeLowConfidence: this.#includeLowConfidence,
          idFactory: () => 'pending',
        });
        for (const beat of result.beats) {
          beats.push(withStableId(beat));
          if (beat.type === 'dialogue' && beat.characterId) presentCharacterIds.add(beat.characterId);
        }
        conflicts.push(...result.conflicts);
        if (result.lastCharacterId) previousCharacterId = result.lastCharacterId;
      }

      if (beats.length === 0) continue;
      beats.sort(compareBeats);

      const scene: ReconstructedScene = {
        id: `scene-${shortHash(`${start}`)}`,
        start,
        end,
        characters: buildPresence([...presentCharacterIds], beats),
        beats: dedupeBeats(beats),
        provenance: mergeProvenance(...beats.map((b) => b.provenance)),
        status: 'provisional',
      };
      const setting = deriveSetting(sceneEvents);
      if (setting) scene.setting = setting;
      scenes.push(scene);
    }

    this.#lastCharacterId = previousCharacterId;
    return { scenes, conflicts };
  }

  /**
   * Promotes scenes that playback has moved safely past.
   *
   * Once finalized a scene stops being recomputed, which bounds the cost of
   * rebuilding regardless of how long the film runs.
   */
  #promoteStableScenes(currentTime: MediaTimeMs): ReconstructedScene[] {
    const cutoff = currentTime - this.#stabilizationMs;
    const stable = this.#provisional.filter((s) => (s.end ?? s.start) < cutoff);
    if (stable.length === 0) return [];

    const promoted = stable.map((scene) => ({ ...scene, status: 'finalized' as const }));
    this.#finalized.push(...promoted);
    this.#finalized.sort((a, b) => a.start - b.start);
    this.#provisional = this.#provisional.filter((s) => (s.end ?? s.start) >= cutoff);
    this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
    return promoted;
  }
}

/**
 * Content-derived beat id.
 *
 * Two rebuilds over the same evidence produce the same id, so React keys stay
 * stable, user edits stay attached, and a rewind does not duplicate the beat.
 */
function withStableId<T extends SceneBeat>(beat: T): T {
  const signature = `${beat.type}|${beat.start}|${beat.provenance.evidenceIds.join(',')}`;
  return { ...beat, id: `beat-${shortHash(signature)}` };
}

function dedupeBeats(beats: readonly SceneBeat[]): SceneBeat[] {
  const seen = new Set<string>();
  const out: SceneBeat[] = [];
  for (const beat of beats) {
    if (seen.has(beat.id)) continue;
    seen.add(beat.id);
    out.push(beat);
  }
  return out;
}

function buildPresence(characterIds: readonly string[], beats: readonly SceneBeat[]): SceneCharacterPresence[] {
  return characterIds.map((characterId) => {
    const lines = beats.filter((b) => b.type === 'dialogue' && b.characterId === characterId);
    const first = lines[0];
    return {
      characterId,
      speaks: lines.length > 0,
      ...(first ? { enteredAt: first.start } : {}),
      confidence: lines.length > 1 ? 'high' : 'medium',
    };
  });
}

/**
 * Derives a scene heading from evidence.
 *
 * Only from evidence. A room that looks residential does not become
 * "DANIEL'S APARTMENT" — that would be inventing a fact about whose home it is.
 * When nothing supports a specific setting the scene simply has none, and the
 * renderer prints a deliberately vague heading.
 */
function deriveSetting(events: readonly EvidenceEvent[]): SceneSetting | undefined {
  const settingEvents = events.filter(
    (e): e is VisualEvidence => e.source === 'video' && e.payload.kind === 'setting' && Boolean(e.payload.description),
  );
  if (settingEvents.length === 0) return undefined;

  const best = settingEvents.reduce((a, b) => (rank(b.confidence) > rank(a.confidence) ? b : a));
  const description = best.payload.description!;

  const setting: SceneSetting = {
    description,
    confidence: minConfidence(best.confidence, 'medium'),
    inferred: best.payload.inferred ?? true,
  };

  const interiorExterior = parseInteriorExterior(description);
  if (interiorExterior) setting.interiorExterior = interiorExterior;
  const timeOfDay = parseTimeOfDay(description);
  if (timeOfDay) setting.timeOfDay = timeOfDay;
  // Keeps the provenance chain intact even though it is not stored on the setting.
  void provenanceFrom(settingEvents);
  return setting;
}

function rank(confidence: string): number {
  return { high: 3, medium: 2, low: 1, unknown: 0 }[confidence] ?? 0;
}

function parseInteriorExterior(description: string): 'INT' | 'EXT' | 'UNKNOWN' | undefined {
  if (/\b(int\.?|interior|indoors?|inside)\b/i.test(description)) return 'INT';
  if (/\b(ext\.?|exterior|outdoors?|outside|street|park|forest|beach)\b/i.test(description)) return 'EXT';
  return undefined;
}

function parseTimeOfDay(description: string): string | undefined {
  const match = /\b(day|night|dawn|dusk|morning|afternoon|evening|sunset|sunrise)\b/i.exec(description);
  return match ? match[1]!.toUpperCase() : undefined;
}
