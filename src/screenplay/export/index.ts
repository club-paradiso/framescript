/**
 * Export formats.
 *
 * Fountain lives in its own file; the remaining four are short enough to share
 * one. Every format carries the same reconstruction disclaimer, because the
 * risk of a FrameScript document being mistaken for an official screenplay does
 * not depend on its file extension.
 */

import { formatSrtTimestamp, formatTimecode } from '../../utils/time';
import { slugify } from '../../utils/text';
import { describeSources } from '../../evidence/provenance';
import type { ReconstructedScene } from '../../scenes/types';
import type { CharacterEntity } from '../../characters/entities';
import type { FusionConflict } from '../../scenes/fusion';
import {
  FRAMESCRIPT_PROJECT_FORMAT,
  FRAMESCRIPT_PROJECT_VERSION,
  type ProjectCoverage,
  type ProjectSourceSummary,
} from '../../storage/projectFormat';
import type { ScreenplayDocument } from '../types';
import { documentToText } from '../languageRenderer';
import { toFountain, type ExportMetadata, type FountainOptions } from './fountain';

export type ExportFormat = 'fountain' | 'markdown' | 'text' | 'json' | 'srt';

export interface ExportOptions extends FountainOptions {
  format: ExportFormat;
  /** Dialogue only, dropping action, sound and on-screen text. */
  dialogueOnly?: boolean;
}

export const RECONSTRUCTION_NOTICE =
  'Reconstructed by FrameScript from observable playback evidence. This is not an original, shooting, or production screenplay, and it was not supplied by the streaming service.';

export interface ExportResult {
  filename: string;
  mimeType: string;
  content: string;
}

export interface ExportExtras {
  scenes?: readonly ReconstructedScene[];
  characters?: readonly CharacterEntity[];
  languages?: readonly string[];
  coverage?: ProjectCoverage;
  conflicts?: readonly FusionConflict[];
  sources?: readonly ProjectSourceSummary[];
}

export function exportScreenplay(
  document: ScreenplayDocument,
  metadata: ExportMetadata,
  options: ExportOptions,
  extras: ExportExtras = {},
): ExportResult {
  const filtered = options.dialogueOnly
    ? {
        ...document,
        lines: document.lines.filter((l) => l.kind === 'dialogue' || l.kind === 'character'),
      }
    : document;

  switch (options.format) {
    case 'fountain':
      return {
        filename: buildFilename(metadata, document.language, 'fountain'),
        mimeType: 'text/plain;charset=utf-8',
        content: toFountain(filtered, metadata, options),
      };
    case 'markdown':
      return {
        filename: buildFilename(metadata, document.language, 'md'),
        mimeType: 'text/markdown;charset=utf-8',
        content: toMarkdown(filtered, metadata, options),
      };
    case 'text':
      return {
        filename: buildFilename(metadata, document.language, 'txt'),
        mimeType: 'text/plain;charset=utf-8',
        content: `${RECONSTRUCTION_NOTICE}\n\n${documentToText(filtered, { timestamps: options.includeTimestamps ?? false })}\n`,
      };
    case 'srt':
      return {
        filename: buildFilename(metadata, document.language, 'srt'),
        mimeType: 'application/x-subrip;charset=utf-8',
        content: toSrt(filtered),
      };
    case 'json':
      return {
        filename: buildFilename(metadata, document.language, 'json'),
        mimeType: 'application/json;charset=utf-8',
        content: toJson(filtered, metadata, extras),
      };
  }
}

export function toMarkdown(
  document: ScreenplayDocument,
  metadata: ExportMetadata,
  options: ExportOptions,
): string {
  const out: string[] = [];
  out.push(`# ${metadata.title ?? 'Untitled'}`);
  if (metadata.seriesTitle) out.push(`**${metadata.seriesTitle}**`);
  out.push('');
  out.push(`> ${RECONSTRUCTION_NOTICE}`);
  out.push('');
  if (metadata.coverage?.length) {
    for (const line of metadata.coverage) out.push(`> ${line}`);
    out.push('');
  }

  for (const line of document.lines) {
    const stamp = options.includeTimestamps ? ` \`${formatTimecode(line.start)}\`` : '';
    switch (line.kind) {
      case 'scene-heading':
        out.push('');
        out.push(`## ${line.text}${stamp}`);
        out.push('');
        break;
      case 'character':
        out.push(`**${line.text}**`);
        break;
      case 'dialogue': {
        out.push(`> ${line.text}`);
        if (options.dualLanguage && line.secondaryText) out.push(`> ${line.secondaryText}`);
        const tags = buildTags(line, options);
        if (tags) out.push(`> <sub>${tags}</sub>`);
        out.push('');
        break;
      }
      case 'transition':
        out.push('');
        out.push(`*${line.text}*`);
        out.push('');
        break;
      default:
        out.push(`${line.text}${stamp}`);
        out.push('');
        break;
    }
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

function buildTags(
  line: ScreenplayDocument['lines'][number],
  options: ExportOptions,
): string | null {
  const parts: string[] = [];
  if (line.origin === 'ai-translation') parts.push('AI translation');
  if (line.origin === 'audio-asr') parts.push('audio transcription');
  if (line.fallbackLanguage) parts.push(`shown in ${line.fallbackLanguage}`);
  if (options.includeConfidence && line.confidence) parts.push(line.confidence);
  if (options.includeEvidenceRefs && line.provenance)
    parts.push(describeSources(line.provenance.sources));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * SRT export.
 *
 * Only dialogue becomes subtitles — action and sound descriptions are not
 * things anyone said, and burning them into a subtitle track would misrepresent
 * them as speech.
 */
export function toSrt(document: ScreenplayDocument): string {
  const dialogue = document.lines.filter((l) => l.kind === 'dialogue');
  const out: string[] = [];

  dialogue.forEach((line, index) => {
    const end = line.end ?? line.start + 2_000;
    out.push(String(index + 1));
    out.push(
      `${formatSrtTimestamp(line.start)} --> ${formatSrtTimestamp(Math.max(end, line.start + 500))}`,
    );
    out.push(line.text);
    if (line.secondaryText) out.push(line.secondaryText);
    out.push('');
  });

  return out.join('\n');
}

export function toJson(
  document: ScreenplayDocument,
  metadata: ExportMetadata,
  extras: ExportExtras = {},
): string {
  return `${JSON.stringify(
    {
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: FRAMESCRIPT_PROJECT_VERSION,
      notice: RECONSTRUCTION_NOTICE,
      metadata,
      language: document.language,
      lines: document.lines,
      scenes: extras.scenes ?? undefined,
      characters: extras.characters ?? undefined,
      languages: extras.languages ?? [document.language],
      coverage: extras.coverage ?? { observed: [], uncovered: [], notes: metadata.coverage ?? [] },
      conflicts: extras.conflicts ?? [],
      sources: extras.sources ?? [],
    },
    null,
    2,
  )}\n`;
}

/**
 * Builds a filesystem-safe filename, e.g. `the-bear-s02e03.ko.fountain`.
 */
export function buildFilename(
  metadata: ExportMetadata,
  language: string,
  extension: string,
): string {
  const parts: string[] = [];
  if (metadata.seriesTitle) parts.push(slugify(metadata.seriesTitle));
  else if (metadata.title) parts.push(slugify(metadata.title));
  else parts.push('framescript');

  if (metadata.season !== undefined && metadata.episode !== undefined) {
    parts.push(
      `s${String(metadata.season).padStart(2, '0')}e${String(metadata.episode).padStart(2, '0')}`,
    );
  } else if (metadata.seriesTitle && metadata.title) {
    parts.push(slugify(metadata.title, 40));
  }

  const base = parts.filter(Boolean).join('-');
  return `${base}.${slugify(language, 12)}.${extension}`;
}
