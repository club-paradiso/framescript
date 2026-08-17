/**
 * Language rendering.
 *
 * Projects the shared scene model into one language's screenplay.
 *
 * Two rules define what this file will and will not do:
 *
 *  1. Dialogue prefers a *platform subtitle* in the target language. If none
 *     exists it falls back to another language's real subtitle, or to an AI
 *     translation if one was produced — and it always records which, so the UI
 *     can label it. A translation is never presented as a platform subtitle.
 *
 *  2. Structural vocabulary (INT/EXT, time of day, O.S.) is localized from a
 *     fixed table, because that vocabulary is a screenplay convention rather
 *     than content. Action *descriptions* are only localized when a language
 *     provider actually produced them; otherwise they render in the language
 *     they were derived in and are marked as such.
 */

import { formatTimecode } from '../utils/time';
import type { MediaTimeMs } from '../utils/time';
import { characterCueName, type CharacterEntity } from '../characters/entities';
import {
  dialogueTextFor,
  type ReconstructedScene,
  type SceneBeat,
  type SceneSetting,
} from '../scenes/types';
import type { ScreenplayDocument, ScreenplayLine } from './types';

export interface RenderOptions {
  language: string;
  secondaryLanguage?: string;
  characters: readonly CharacterEntity[];
  /** Fallback order when the target language has no variant. */
  fallbackLanguages?: readonly string[];
  includeTransitions?: boolean;
  /** Include beats whose only support is low-confidence inference. */
  includeLowConfidence?: boolean;
}

interface StructuralStrings {
  interior: string;
  exterior: string;
  unknownPlace: string;
  unknownTime: string;
  offScreen: string;
  onScreenText: string;
  continuous: string;
  timesOfDay: Record<string, string>;
}

/**
 * Structural vocabulary per language.
 *
 * Only languages with a real entry are localized. Anything else falls back to
 * English convention, which is standard practice in international screenwriting
 * and is honest about not having been localized.
 */
const STRUCTURAL: Record<string, StructuralStrings> = {
  en: {
    interior: 'INT.',
    exterior: 'EXT.',
    unknownPlace: 'UNKNOWN LOCATION',
    unknownTime: 'UNKNOWN TIME',
    offScreen: 'O.S.',
    onScreenText: 'ON SCREEN:',
    continuous: 'CONTINUOUS',
    timesOfDay: { DAY: 'DAY', NIGHT: 'NIGHT', DAWN: 'DAWN', DUSK: 'DUSK', MORNING: 'MORNING', EVENING: 'EVENING' },
  },
  ko: {
    interior: '실내.',
    exterior: '실외.',
    unknownPlace: '장소 불명',
    unknownTime: '시간 불명',
    offScreen: '(소리)',
    onScreenText: '화면 자막:',
    continuous: '연속',
    timesOfDay: { DAY: '낮', NIGHT: '밤', DAWN: '새벽', DUSK: '해질녘', MORNING: '아침', EVENING: '저녁' },
  },
  ja: {
    interior: '屋内.',
    exterior: '屋外.',
    unknownPlace: '場所不明',
    unknownTime: '時間不明',
    offScreen: '(声)',
    onScreenText: '画面表示:',
    continuous: '連続',
    timesOfDay: { DAY: '昼', NIGHT: '夜', DAWN: '夜明け', DUSK: '夕暮れ', MORNING: '朝', EVENING: '夕方' },
  },
  es: {
    interior: 'INT.',
    exterior: 'EXT.',
    unknownPlace: 'LUGAR DESCONOCIDO',
    unknownTime: 'HORA DESCONOCIDA',
    offScreen: 'F.C.',
    onScreenText: 'EN PANTALLA:',
    continuous: 'CONTINUO',
    timesOfDay: { DAY: 'DÍA', NIGHT: 'NOCHE', DAWN: 'AMANECER', DUSK: 'ANOCHECER', MORNING: 'MAÑANA', EVENING: 'TARDE' },
  },
};

function structuralFor(language: string): StructuralStrings {
  return STRUCTURAL[language] ?? STRUCTURAL[language.split('-')[0] ?? ''] ?? STRUCTURAL.en!;
}

export const SUPPORTED_SCRIPT_LANGUAGES = Object.keys(STRUCTURAL);

/**
 * Formats a scene heading.
 *
 * Deliberately vague when the evidence is vague. `INT. ROOM - UNKNOWN TIME` is
 * a correct heading for a scene we only know is indoors; inventing a specific
 * location would not be.
 */
export function formatSceneHeading(setting: SceneSetting | undefined, language: string): string | null {
  const strings = structuralFor(language);
  if (!setting?.description) return null;

  const prefix =
    setting.interiorExterior === 'INT'
      ? strings.interior
      : setting.interiorExterior === 'EXT'
        ? strings.exterior
        : '';

  const place = setting.description.trim().toLocaleUpperCase(language === 'en' ? 'en' : undefined);
  const time = setting.timeOfDay ? (strings.timesOfDay[setting.timeOfDay] ?? setting.timeOfDay) : strings.unknownTime;

  return [prefix, place, '-', time].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function renderScreenplay(
  scenes: readonly ReconstructedScene[],
  options: RenderOptions,
): ScreenplayDocument {
  const strings = structuralFor(options.language);
  const characterMap = new Map(options.characters.map((c) => [c.id, c]));
  const lines: ScreenplayLine[] = [];
  const fallbacks = options.fallbackLanguages ?? [];

  const ordered = [...scenes].sort((a, b) => a.start - b.start);

  for (const scene of ordered) {
    const heading = formatSceneHeading(scene.setting, options.language);
    if (heading) {
      lines.push({
        id: `${scene.id}-heading`,
        kind: 'scene-heading',
        text: heading,
        start: scene.start,
        sceneId: scene.id,
        ...(scene.setting ? { confidence: scene.setting.confidence } : {}),
      });
    }

    for (const beat of scene.beats) {
      lines.push(...renderBeat(beat, scene.id, options, strings, characterMap, fallbacks));
    }
  }

  lines.sort((a, b) => a.start - b.start);
  return {
    language: options.language,
    ...(options.secondaryLanguage ? { secondaryLanguage: options.secondaryLanguage } : {}),
    lines,
    start: ordered[0]?.start ?? 0,
    end: ordered[ordered.length - 1]?.end ?? ordered[ordered.length - 1]?.start ?? 0,
  };
}

function renderBeat(
  beat: SceneBeat,
  sceneId: string,
  options: RenderOptions,
  strings: StructuralStrings,
  characters: Map<string, CharacterEntity>,
  fallbacks: readonly string[],
): ScreenplayLine[] {
  switch (beat.type) {
    case 'dialogue': {
      const variant = dialogueTextFor(beat, options.language, fallbacks);
      if (!variant) return [];

      const character = beat.characterId ? characters.get(beat.characterId) : undefined;
      const cue = characterCueName(character);
      const out: ScreenplayLine[] = [
        {
          id: `${beat.id}-cue`,
          kind: 'character',
          text: beat.parenthetical ? `${cue} (${beat.parenthetical})` : cue,
          start: beat.start,
          sceneId,
          beatId: beat.id,
          ...(beat.characterId ? { characterId: beat.characterId } : {}),
          provenance: beat.provenance,
        },
      ];

      const line: ScreenplayLine = {
        id: `${beat.id}-text`,
        kind: 'dialogue',
        text: variant.text,
        start: beat.start,
        ...(beat.end === undefined ? {} : { end: beat.end }),
        sceneId,
        beatId: beat.id,
        ...(beat.characterId ? { characterId: beat.characterId } : {}),
        provenance: beat.provenance,
        origin: variant.origin,
        confidence: variant.confidence,
      };
      if (variant.language !== options.language) line.fallbackLanguage = variant.language;

      if (options.secondaryLanguage) {
        const secondary = dialogueTextFor(beat, options.secondaryLanguage, []);
        // Only show a genuinely different variant; echoing the same string in
        // both columns would misrepresent a missing track as a translation.
        if (secondary && secondary.language !== variant.language) line.secondaryText = secondary.text;
      }
      out.push(line);
      return out;
    }

    case 'action': {
      const text = beat.localized?.[options.language] ?? beat.description;
      const line: ScreenplayLine = {
        id: beat.id,
        kind: 'action',
        text,
        start: beat.start,
        ...(beat.end === undefined ? {} : { end: beat.end }),
        sceneId,
        beatId: beat.id,
        provenance: beat.provenance,
        confidence: beat.provenance.confidence,
      };
      if (!beat.localized?.[options.language] && options.language !== 'en') line.fallbackLanguage = 'en';
      return [line];
    }

    case 'sound': {
      const text = beat.localized?.[options.language] ?? beat.description;
      const line: ScreenplayLine = {
        id: beat.id,
        kind: 'sound',
        text,
        start: beat.start,
        ...(beat.end === undefined ? {} : { end: beat.end }),
        sceneId,
        beatId: beat.id,
        provenance: beat.provenance,
        confidence: beat.provenance.confidence,
      };
      if (!beat.localized?.[options.language] && options.language !== 'en') line.fallbackLanguage = 'en';
      return [line];
    }

    case 'on-screen-text':
      return [
        {
          id: beat.id,
          kind: 'on-screen-text',
          text: `${strings.onScreenText} "${beat.text}"`,
          start: beat.start,
          ...(beat.end === undefined ? {} : { end: beat.end }),
          sceneId,
          beatId: beat.id,
          provenance: beat.provenance,
          confidence: beat.provenance.confidence,
        },
      ];

    case 'transition':
      if (options.includeTransitions === false) return [];
      return [
        {
          id: beat.id,
          kind: 'transition',
          text: beat.label,
          start: beat.start,
          sceneId,
          beatId: beat.id,
          provenance: beat.provenance,
        },
      ];
  }
}

/** Plain-text rendering used by the text export and by copy-to-clipboard. */
export function documentToText(
  document: ScreenplayDocument,
  options: { timestamps?: boolean } = {},
): string {
  const out: string[] = [];
  let lastKind: string | null = null;

  for (const line of document.lines) {
    const prefix = options.timestamps ? `[${formatTimecode(line.start)}] ` : '';
    switch (line.kind) {
      case 'scene-heading':
        if (lastKind !== null) out.push('');
        out.push(`${prefix}${line.text}`);
        out.push('');
        break;
      case 'character':
        out.push(`${prefix}${indent(line.text, 20)}`);
        break;
      case 'dialogue':
        out.push(indent(line.text, 10));
        if (line.secondaryText) out.push(indent(line.secondaryText, 10));
        out.push('');
        break;
      case 'transition':
        out.push('');
        out.push(indent(line.text, 50));
        out.push('');
        break;
      default:
        out.push(`${prefix}${line.text}`);
        out.push('');
        break;
    }
    lastKind = line.kind;
  }
  // Collapse blank runs and trim leading/trailing blank LINES only. A plain
  // `.trim()` would strip the leading indentation off the first line, and
  // indentation is what makes this a screenplay rather than a transcript.
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}

function indent(text: string, columns: number): string {
  return `${' '.repeat(columns)}${text}`;
}

/** Coverage note appended to exports so gaps are never silently implied. */
export function coverageNote(
  observedRatio: number | undefined,
  uncovered: readonly { start: MediaTimeMs; end: MediaTimeMs }[],
): string[] {
  if (observedRatio === undefined) return ['Analysis coverage: unknown (media duration was not reported).'];
  const lines = [`Analysis coverage: ${Math.round(observedRatio * 100)}% of the media was observed.`];
  if (uncovered.length > 0) {
    lines.push('Unobserved ranges (nothing was reconstructed for these):');
    for (const range of uncovered.slice(0, 20)) {
      lines.push(`  ${formatTimecode(range.start)} - ${formatTimecode(range.end)}`);
    }
    if (uncovered.length > 20) lines.push(`  ...and ${uncovered.length - 20} more.`);
  }
  return lines;
}
