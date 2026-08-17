/**
 * Persisted screenplay schema.
 *
 * Two storage tiers, deliberately separated:
 *
 *   - **Ephemeral session data** lives only in memory while analysis runs. It
 *     disappears when the tab closes. Every analyzed film is *not* silently
 *     kept forever.
 *   - **Saved scripts** are written here, and only when the user asks.
 *
 * Raw audio and raw frames are never part of this schema. There is no field
 * that could hold them and no code path that would write one.
 */

import type { CharacterEntity } from '../characters/entities';
import type { ReconstructedScene } from '../scenes/types';
import type { TimeRange } from '../utils/time';

export const SCREENPLAY_SCHEMA_VERSION = 2;

export interface CoverageRecord {
  observed: TimeRange[];
  durationMs?: number;
  /** Fraction of the media actually observed, in [0,1]. */
  ratio?: number;
}

export interface LanguageVariantIndex {
  /** Languages for which platform subtitle evidence exists. */
  platformSubtitles: string[];
  /** Languages produced by audio transcription. */
  transcribed: string[];
  /** Languages produced by AI translation, tracked separately on purpose. */
  translated: string[];
}

export interface StoredScreenplay {
  schemaVersion: number;
  id: string;
  platform: 'youtube' | 'netflix';
  contentId: string;
  title?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  createdAt: number;
  updatedAt: number;
  coverage: CoverageRecord;
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languageVariants: LanguageVariantIndex;
  /** Fidelity the analysis ran at, so a reader knows how dense it was. */
  fidelity?: string;
  /** True if any part of this screenplay used remote AI inference. */
  usedRemoteAi?: boolean;
}

export interface ScreenplaySummary {
  id: string;
  platform: 'youtube' | 'netflix';
  contentId: string;
  title?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  updatedAt: number;
  sceneCount: number;
  languages: string[];
  coverageRatio?: number;
}

export function summarize(record: StoredScreenplay): ScreenplaySummary {
  return {
    id: record.id,
    platform: record.platform,
    contentId: record.contentId,
    ...(record.title ? { title: record.title } : {}),
    ...(record.seriesTitle ? { seriesTitle: record.seriesTitle } : {}),
    ...(record.season === undefined ? {} : { season: record.season }),
    ...(record.episode === undefined ? {} : { episode: record.episode }),
    updatedAt: record.updatedAt,
    sceneCount: record.scenes.length,
    languages: [
      ...new Set([
        ...record.languageVariants.platformSubtitles,
        ...record.languageVariants.transcribed,
        ...record.languageVariants.translated,
      ]),
    ],
    ...(record.coverage.ratio === undefined ? {} : { coverageRatio: record.coverage.ratio }),
  };
}

/** Deterministic id so re-watching the same episode updates one record. */
export function screenplayId(platform: string, contentId: string): string {
  return `${platform}:${contentId}`;
}
