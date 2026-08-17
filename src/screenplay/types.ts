/**
 * Rendered screenplay model.
 *
 * A `ScreenplayDocument` is one language's view of the shared scene model. The
 * scene model is computed once; documents are cheap projections of it. That is
 * the whole multilingual design: expensive multimodal analysis happens once,
 * and English, Korean and Japanese screenplays are renderings of the same
 * understanding rather than three independent analyses.
 */

import type { ConfidenceLevel, Provenance } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';
import type { DialogueVariant } from '../scenes/types';

export type ScreenplayLineKind =
  | 'scene-heading'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'sound'
  | 'on-screen-text'
  | 'transition';

export interface ScreenplayLine {
  id: string;
  kind: ScreenplayLineKind;
  text: string;
  /** Second language's text when the dual-language view is on. */
  secondaryText?: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  sceneId: string;
  beatId?: string;
  characterId?: string;
  provenance?: Provenance;
  /** For dialogue: whether this text is a platform subtitle or a translation. */
  origin?: DialogueVariant['origin'];
  confidence?: ConfidenceLevel;
  /**
   * True when no text was available in the target language and the line fell
   * back to another. The UI marks these rather than pretending they translated.
   */
  fallbackLanguage?: string;
}

export interface ScreenplayDocument {
  language: string;
  secondaryLanguage?: string;
  lines: ScreenplayLine[];
  /** Media time covered by the rendered scenes. */
  start: MediaTimeMs;
  end: MediaTimeMs;
}

export function emptyDocument(language: string): ScreenplayDocument {
  return { language, lines: [], start: 0, end: 0 };
}

/** Index of the line active at `time`, or -1. Used for playback following. */
export function activeLineIndex(document: ScreenplayDocument, time: MediaTimeMs): number {
  const lines = document.lines;
  let low = 0;
  let high = lines.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.start <= time) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
