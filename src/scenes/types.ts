/**
 * The structured scene model.
 *
 * This is the layer between evidence and prose. Nothing generates screenplay
 * text directly from evidence — it must become a scene with typed beats first.
 *
 * That indirection is what makes the multilingual design work: one scene model
 * is shared, and each language renders from it. It is also what makes
 * provenance possible, since every beat carries the evidence that justifies it.
 */

import type { ConfidenceLevel, Provenance } from '../evidence/types';
import type { SoundEventKind } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';
import type { SceneCharacterPresence } from '../characters/entities';

/** One language's text for a line of dialogue. */
export interface DialogueVariant {
  language: string;
  text: string;
  /**
   * Where this text came from. `platform-subtitle` and `ai-translation` are
   * never conflated — the UI labels them differently and export records both.
   */
  origin: 'platform-subtitle' | 'audio-asr' | 'ai-translation';
  confidence: ConfidenceLevel;
}

export interface DialogueBeat {
  type: 'dialogue';
  id: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  characterId?: string;
  /** How the speaker was determined; shown in the Evidence view. */
  attributionMethod?: string;
  /** Language code -> text. Populated per available track. */
  textVariants: Record<string, DialogueVariant>;
  /** Parenthetical such as `(O.S.)` when the speaker is off-screen. */
  parenthetical?: string;
  provenance: Provenance;
}

export interface ActionBeat {
  type: 'action';
  id: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  description: string;
  participantIds?: string[];
  /** Localized phrasings when a language provider rendered them. */
  localized?: Record<string, string>;
  provenance: Provenance;
}

export interface SoundBeat {
  type: 'sound';
  id: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  kind: SoundEventKind;
  description: string;
  localized?: Record<string, string>;
  provenance: Provenance;
}

export interface OnScreenTextBeat {
  type: 'on-screen-text';
  id: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  text: string;
  provenance: Provenance;
}

export interface TransitionBeat {
  type: 'transition';
  id: string;
  start: MediaTimeMs;
  /** `CUT TO:` and friends. Only emitted where a cut was actually detected. */
  label: string;
  provenance: Provenance;
}

export type SceneBeat = DialogueBeat | ActionBeat | SoundBeat | OnScreenTextBeat | TransitionBeat;

export interface SceneSetting {
  description?: string;
  interiorExterior?: 'INT' | 'EXT' | 'UNKNOWN';
  timeOfDay?: string;
  confidence: ConfidenceLevel;
  /** True when the setting came from a model rather than observed text. */
  inferred: boolean;
}

export interface ReconstructedScene {
  id: string;
  start: MediaTimeMs;
  end?: MediaTimeMs;
  setting?: SceneSetting;
  characters: SceneCharacterPresence[];
  beats: SceneBeat[];
  provenance: Provenance;
  /**
   * `provisional` scenes can still be revised by later evidence; `finalized`
   * ones are stable enough to save and export.
   */
  status: 'provisional' | 'finalized';
}

export function beatSortKey(beat: SceneBeat): number {
  return beat.start;
}

/**
 * Ordering within a scene.
 *
 * Ties are broken by type so a transition precedes the action it introduces and
 * a sound that triggers a reaction precedes the reaction — the reading order a
 * screenplay expects.
 */
const TYPE_ORDER: Record<SceneBeat['type'], number> = {
  transition: 0,
  'on-screen-text': 1,
  sound: 2,
  action: 3,
  dialogue: 4,
};

export function compareBeats(a: SceneBeat, b: SceneBeat): number {
  return a.start - b.start || TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
}

export function isDialogueBeat(beat: SceneBeat): beat is DialogueBeat {
  return beat.type === 'dialogue';
}

export function isActionBeat(beat: SceneBeat): beat is ActionBeat {
  return beat.type === 'action';
}

/** Best available text for a dialogue beat in a target language. */
export function dialogueTextFor(
  beat: DialogueBeat,
  language: string,
  fallbackOrder: readonly string[] = [],
): DialogueVariant | undefined {
  const exact = beat.textVariants[language];
  if (exact) return exact;
  for (const code of fallbackOrder) {
    const variant = beat.textVariants[code];
    if (variant) return variant;
  }
  // Prefer a real platform subtitle in any language over an AI translation.
  const variants = Object.values(beat.textVariants);
  return (
    variants.find((v) => v.origin === 'platform-subtitle') ??
    variants.find((v) => v.origin === 'audio-asr') ??
    variants[0]
  );
}

export function sceneLanguages(scene: ReconstructedScene): string[] {
  const codes = new Set<string>();
  for (const beat of scene.beats) {
    if (beat.type === 'dialogue') for (const code of Object.keys(beat.textVariants)) codes.add(code);
  }
  return [...codes];
}
