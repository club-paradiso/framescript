/**
 * Native FrameScript project interchange.
 *
 * This is intentionally shared by every surface. It validates the structural
 * model at the trust boundary before UI code, the CLI, or an agent can consume
 * a user-provided JSON file. Unknown future versions are rejected rather than
 * partially opened and re-exported with data silently missing.
 */

import type { CharacterEntity } from '../characters/entities';
import type { ConfidenceLevel, Provenance } from '../evidence/types';
import type { FusionConflict } from '../scenes/fusion';
import type { ReconstructedScene, SceneBeat } from '../scenes/types';
import type { ExportMetadata } from '../screenplay/export/fountain';
import type { TimeRange } from '../utils/time';
import { migrateScreenplay } from './migrations';

export const FRAMESCRIPT_PROJECT_FORMAT = 'framescript-screenplay';
export const FRAMESCRIPT_PROJECT_VERSION = 2;

const MAX_SCENES = 10_000;
const MAX_BEATS = 250_000;
const MAX_CHARACTERS = 25_000;
const MAX_TEXT_LENGTH = 250_000;

export interface ProjectCoverage {
  ratio?: number;
  durationMs?: number;
  observed: TimeRange[];
  uncovered: TimeRange[];
  notes: string[];
}

export interface ProjectSourceSummary {
  name: string;
  kind: 'subtitle' | 'media' | 'project';
  detail?: string;
  language?: string;
}

export interface FrameScriptProject {
  format: typeof FRAMESCRIPT_PROJECT_FORMAT;
  formatVersion: typeof FRAMESCRIPT_PROJECT_VERSION;
  metadata: ExportMetadata;
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languages: string[];
  coverage: ProjectCoverage;
  conflicts: FusionConflict[];
  sources: ProjectSourceSummary[];
}

export type ProjectParseResult =
  | { ok: true; project: FrameScriptProject; migratedFrom?: number; warnings: string[] }
  | { ok: false; error: string };

export function parseFrameScriptProject(raw: unknown): ProjectParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'The project root must be a JSON object.' };

  if (raw.format === FRAMESCRIPT_PROJECT_FORMAT) return parseExport(raw);

  // Saved extension records predate the explicit interchange envelope. Keep
  // accepting them, but only through the storage migration chain.
  if (typeof raw.schemaVersion === 'number') {
    const migrated = migrateScreenplay(raw);
    if (!migrated) {
      return { ok: false, error: 'This saved project uses an unsupported schema version.' };
    }
    const structural = validateModel(migrated.record.scenes, migrated.record.characters);
    if (structural) return { ok: false, error: structural };

    return {
      ok: true,
      migratedFrom: migrated.fromVersion,
      warnings: migrated.migrated
        ? [`Upgraded saved project schema v${migrated.fromVersion}.`]
        : [],
      project: {
        format: FRAMESCRIPT_PROJECT_FORMAT,
        formatVersion: FRAMESCRIPT_PROJECT_VERSION,
        metadata: {
          ...(migrated.record.title ? { title: migrated.record.title } : {}),
          ...(migrated.record.seriesTitle ? { seriesTitle: migrated.record.seriesTitle } : {}),
          ...(migrated.record.season === undefined ? {} : { season: migrated.record.season }),
          ...(migrated.record.episode === undefined ? {} : { episode: migrated.record.episode }),
          platform: migrated.record.platform,
        },
        scenes: migrated.record.scenes,
        characters: migrated.record.characters,
        languages: uniqueStrings([
          ...migrated.record.languageVariants.platformSubtitles,
          ...migrated.record.languageVariants.transcribed,
          ...migrated.record.languageVariants.translated,
        ]),
        coverage: {
          ...(validRatio(migrated.record.coverage.ratio)
            ? { ratio: migrated.record.coverage.ratio }
            : {}),
          ...(validTime(migrated.record.coverage.durationMs)
            ? { durationMs: migrated.record.coverage.durationMs }
            : {}),
          observed: validRanges(migrated.record.coverage.observed),
          uncovered: [],
          notes: [],
        },
        conflicts: [],
        sources: [],
      },
    };
  }

  return { ok: false, error: 'This JSON file is not a FrameScript project.' };
}

function parseExport(record: Record<string, unknown>): ProjectParseResult {
  const version = record.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'The FrameScript project version is missing or invalid.' };
  }
  if (version > FRAMESCRIPT_PROJECT_VERSION) {
    return {
      ok: false,
      error: `This project uses FrameScript format v${version}; this build supports up to v${FRAMESCRIPT_PROJECT_VERSION}.`,
    };
  }

  const scenes = record.scenes;
  const characters = record.characters ?? [];
  const structural = validateModel(scenes, characters);
  if (structural) return { ok: false, error: structural };

  const metadata = parseMetadata(record.metadata);
  if (!metadata) return { ok: false, error: 'The project metadata is malformed.' };

  const coverage = parseCoverage(record.coverage, metadata.coverage);
  const conflicts = parseConflicts(record.conflicts);
  const sources = parseSources(record.sources);
  if (!conflicts || !sources)
    return { ok: false, error: 'The project contains malformed diagnostics.' };

  const typedScenes = scenes as ReconstructedScene[];
  const languages = uniqueStrings(
    Array.isArray(record.languages) ? record.languages : collectLanguages(typedScenes),
  );

  return {
    ok: true,
    ...(version < FRAMESCRIPT_PROJECT_VERSION ? { migratedFrom: version } : {}),
    warnings:
      version < FRAMESCRIPT_PROJECT_VERSION ? [`Opened legacy project format v${version}.`] : [],
    project: {
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: FRAMESCRIPT_PROJECT_VERSION,
      metadata,
      scenes: typedScenes,
      characters: characters as CharacterEntity[],
      languages,
      coverage,
      conflicts,
      sources,
    },
  };
}

function validateModel(scenes: unknown, characters: unknown): string | null {
  if (!Array.isArray(scenes) || scenes.length > MAX_SCENES) {
    return `The project must contain at most ${MAX_SCENES.toLocaleString()} scenes.`;
  }
  if (!Array.isArray(characters) || characters.length > MAX_CHARACTERS) {
    return `The project must contain at most ${MAX_CHARACTERS.toLocaleString()} characters.`;
  }

  let beatCount = 0;
  for (const scene of scenes) {
    if (!isScene(scene)) return 'One or more project scenes are malformed.';
    beatCount += scene.beats.length;
    if (beatCount > MAX_BEATS) {
      return `The project must contain at most ${MAX_BEATS.toLocaleString()} screenplay beats.`;
    }
  }
  if (!characters.every(isCharacter)) return 'One or more project characters are malformed.';
  return null;
}

function isScene(value: unknown): value is ReconstructedScene {
  if (!isRecord(value)) return false;
  if (!safeString(value.id) || !validTime(value.start) || !Array.isArray(value.beats)) return false;
  if (value.end !== undefined && !validTime(value.end)) return false;
  if (value.status !== 'provisional' && value.status !== 'finalized') return false;
  if (!Array.isArray(value.characters) || !isProvenance(value.provenance)) return false;
  return value.beats.every(isBeat);
}

function isBeat(value: unknown): value is SceneBeat {
  if (
    !isRecord(value) ||
    !safeString(value.id) ||
    !validTime(value.start) ||
    !isProvenance(value.provenance)
  ) {
    return false;
  }
  if (value.end !== undefined && !validTime(value.end)) return false;
  switch (value.type) {
    case 'dialogue':
      if (!isRecord(value.textVariants)) return false;
      return Object.values(value.textVariants).every(
        (variant) =>
          isRecord(variant) &&
          safeString(variant.language) &&
          safeText(variant.text) &&
          isConfidence(variant.confidence) &&
          ['platform-subtitle', 'audio-asr', 'ai-translation'].includes(String(variant.origin)),
      );
    case 'action':
      return safeText(value.description);
    case 'sound':
      return safeText(value.description) && safeString(value.kind);
    case 'on-screen-text':
      return safeText(value.text);
    case 'transition':
      return safeText(value.label);
    default:
      return false;
  }
}

function isCharacter(value: unknown): value is CharacterEntity {
  return (
    isRecord(value) &&
    safeString(value.id) &&
    (value.displayName === undefined || safeText(value.displayName)) &&
    Array.isArray(value.aliases) &&
    value.aliases.every(safeText) &&
    Array.isArray(value.speakerIds) &&
    value.speakerIds.every(safeString) &&
    Array.isArray(value.visualClusterIds) &&
    value.visualClusterIds.every(safeString) &&
    isConfidence(value.confidence) &&
    typeof value.lineCount === 'number' &&
    Number.isFinite(value.lineCount) &&
    value.lineCount >= 0
  );
}

function isProvenance(value: unknown): value is Provenance {
  return (
    isRecord(value) &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every(safeString) &&
    Array.isArray(value.sources) &&
    value.sources.every(safeString) &&
    isConfidence(value.confidence) &&
    typeof value.inferred === 'boolean'
  );
}

function parseMetadata(value: unknown): ExportMetadata | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  for (const key of ['title', 'seriesTitle', 'platform'] as const) {
    if (value[key] !== undefined && !safeText(value[key])) return null;
  }
  for (const key of ['season', 'episode', 'generatedAt'] as const) {
    if (value[key] !== undefined && (!validTime(value[key]) || value[key] < 0)) return null;
  }
  if (
    value.coverage !== undefined &&
    (!Array.isArray(value.coverage) || !value.coverage.every(safeText))
  ) {
    return null;
  }
  return value as ExportMetadata;
}

function parseCoverage(
  value: unknown,
  legacyNotes: readonly string[] | undefined,
): ProjectCoverage {
  if (!isRecord(value)) {
    return { observed: [], uncovered: [], notes: uniqueStrings(legacyNotes ?? []) };
  }
  return {
    ...(validRatio(value.ratio) ? { ratio: value.ratio } : {}),
    ...(validTime(value.durationMs) ? { durationMs: value.durationMs } : {}),
    observed: validRanges(value.observed),
    uncovered: validRanges(value.uncovered),
    notes: uniqueStrings(Array.isArray(value.notes) ? value.notes : (legacyNotes ?? [])),
  };
}

function parseConflicts(value: unknown): FusionConflict[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BEATS) return null;
  if (
    !value.every(
      (entry) =>
        isRecord(entry) &&
        validTime(entry.timestamp) &&
        safeText(entry.description) &&
        Array.isArray(entry.evidenceIds) &&
        entry.evidenceIds.every(safeString),
    )
  )
    return null;
  return value as FusionConflict[];
}

function parseSources(value: unknown): ProjectSourceSummary[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) return null;
  if (
    !value.every(
      (source) =>
        isRecord(source) &&
        safeText(source.name) &&
        ['subtitle', 'media', 'project'].includes(String(source.kind)) &&
        (source.detail === undefined || safeText(source.detail)) &&
        (source.language === undefined || safeString(source.language)),
    )
  )
    return null;
  return value as ProjectSourceSummary[];
}

function validRanges(value: unknown): TimeRange[] {
  if (!Array.isArray(value) || value.length > MAX_BEATS) return [];
  return value.filter(
    (range): range is TimeRange =>
      isRecord(range) && validTime(range.start) && validTime(range.end) && range.end >= range.start,
  );
}

function collectLanguages(scenes: readonly ReconstructedScene[]): string[] {
  const languages: string[] = [];
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.type !== 'dialogue') continue;
      for (const language of Object.keys(beat.textVariants)) {
        if (language !== 'und' && !languages.includes(language)) languages.push(language);
      }
    }
  }
  return languages;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(safeString))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function isConfidence(value: unknown): value is ConfidenceLevel {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'unknown';
}
