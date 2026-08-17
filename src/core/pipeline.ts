/**
 * The reusable reconstruction pipeline.
 *
 * The extension drives this incrementally from a live player. The web app, the
 * CLI and the MCP server drive it in one pass over evidence they already have.
 * Both paths run the *same* engine — this file is the seam that proves the
 * scene model is genuinely platform-independent rather than merely described
 * that way.
 *
 * Nothing here touches `chrome.*`, the DOM, or the network.
 */

import { EvidenceTimeline } from '../evidence/timeline';
import type { EvidenceEvent } from '../evidence/types';
import { CharacterRegistry, type CharacterEntity } from '../characters/entities';
import { SceneBuilder } from '../scenes/builder';
import type { ReconstructedScene } from '../scenes/types';
import type { FusionConflict } from '../scenes/fusion';
import { renderScreenplay, coverageNote } from '../screenplay/languageRenderer';
import type { ScreenplayDocument } from '../screenplay/types';
import type { MediaTimeMs, TimeRange } from '../utils/time';

export interface BuildOptions {
  /** Media duration, when known. Required for honest coverage reporting. */
  durationMs?: MediaTimeMs;
  /**
   * A range over which the evidence is known to be *complete*.
   *
   * This distinguishes two very different situations that would otherwise
   * report identically:
   *
   *   - The extension watched 31% of a film and skipped the rest. The gaps are
   *     genuinely unobserved and the screenplay is missing what happened there.
   *   - A complete subtitle file was supplied. Every gap between cues was fully
   *     observed; there was simply no dialogue in it.
   *
   * Callers that hold a complete source pass its span here, so coverage
   * reflects "we have everything for this range" rather than implying data was
   * lost between every pair of lines.
   */
  completeSourceRange?: TimeRange;
  /** Language to render. Defaults to the first language with dialogue. */
  language?: string;
  secondaryLanguage?: string;
  includeLowConfidence?: boolean;
  includeTransitions?: boolean;
  /** Scenes older than this behind the end of evidence are finalized. */
  stabilizationMs?: number;
}

export interface BuildResult {
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  document: ScreenplayDocument;
  conflicts: FusionConflict[];
  coverage: {
    ratio?: number;
    observed: TimeRange[];
    uncovered: TimeRange[];
    /** Human-readable lines suitable for an export header. */
    notes: string[];
  };
  /** Languages that have dialogue evidence, in first-seen order. */
  languages: string[];
}

/**
 * Builds a complete screenplay from a finished set of evidence.
 *
 * This is the one-pass counterpart to the extension's rolling rebuild. It uses
 * a stabilization window of zero by default, because when every event is
 * already in hand there is nothing later that could revise a scene.
 */
export function buildScreenplay(
  events: readonly EvidenceEvent[],
  options: BuildOptions = {},
): BuildResult {
  const timeline = new EvidenceTimeline();
  const registry = new CharacterRegistry();

  const lastEventEnd = events.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
  const durationMs = options.durationMs ?? lastEventEnd;
  if (durationMs > 0) timeline.setDuration(durationMs);

  for (const event of events) {
    const { added } = timeline.append(event);
    if (!added) continue;
    const end = event.end ?? event.start;
    timeline.markObserved(event.start, end > event.start ? end : event.start + 100);
  }

  // A complete source covers its whole span, including the quiet parts.
  if (options.completeSourceRange && options.completeSourceRange.end > options.completeSourceRange.start) {
    timeline.markObserved(options.completeSourceRange.start, options.completeSourceRange.end);
  }

  const builder = new SceneBuilder({
    registry,
    // Everything is already known, so nothing needs to stay provisional.
    stabilizationMs: options.stabilizationMs ?? 0,
    includeLowConfidence: options.includeLowConfidence ?? false,
  });

  // Rebuild past the end of the evidence so every scene finalizes.
  const result = builder.rebuild(timeline, Math.max(durationMs, lastEventEnd) + 1);
  const scenes = result.scenes;
  const characters = registry.snapshot();
  const languages = collectLanguages(scenes);

  const language = options.language ?? languages[0] ?? 'en';
  const document = renderScreenplay(scenes, {
    language,
    ...(options.secondaryLanguage ? { secondaryLanguage: options.secondaryLanguage } : {}),
    characters,
    fallbackLanguages: languages,
    ...(options.includeTransitions === undefined
      ? {}
      : { includeTransitions: options.includeTransitions }),
    includeLowConfidence: options.includeLowConfidence ?? false,
  });

  const coverageMap = timeline.coverage();
  const ratio = timeline.coverageRatio();
  const uncovered = timeline.uncoveredRanges();

  return {
    scenes,
    characters,
    document,
    conflicts: [...result.conflicts],
    coverage: {
      ...(ratio === undefined ? {} : { ratio }),
      observed: coverageMap.observed,
      uncovered,
      notes: coverageNote(ratio, uncovered),
    },
    languages,
  };
}

export function collectLanguages(scenes: readonly ReconstructedScene[]): string[] {
  const codes: string[] = [];
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.type !== 'dialogue') continue;
      for (const code of Object.keys(beat.textVariants)) {
        if (code !== 'und' && !codes.includes(code)) codes.push(code);
      }
    }
  }
  return codes;
}

/** Counts beats by type, for summaries in the CLI and MCP responses. */
export function summarizeBeats(scenes: readonly ReconstructedScene[]): Record<string, number> {
  const counts: Record<string, number> = {
    dialogue: 0,
    action: 0,
    sound: 0,
    'on-screen-text': 0,
    transition: 0,
  };
  for (const scene of scenes) {
    for (const beat of scene.beats) counts[beat.type] = (counts[beat.type] ?? 0) + 1;
  }
  return counts;
}
