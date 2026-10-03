/**
 * Continuity between vision windows.
 *
 * Each window used to be described in isolation: the model never learned that
 * the man it called "the man in the black shirt" two windows ago is the same
 * person, nor that the wound it now sees follows the swing it saw before. This
 * tracker remembers what earlier windows reported and hands the next window a
 * short, bounded summary: the setting, the labels already in use, and the last
 * few observed actions.
 *
 * It only ever produces *context for a request*. Nothing here becomes evidence;
 * the next window's answer is still validated, clamped and marked inferred.
 */

import type { MediaTimeMs } from '../utils/time';
import type { VisionWindowAnalysis, VisionWindowRequest } from './types';

export type ContinuityContext = Pick<
  VisionWindowRequest,
  'currentSetting' | 'knownCharacters' | 'recentActions'
>;

interface Timed {
  at: MediaTimeMs;
  text: string;
}

export interface ContinuityOptions {
  /** How far back an action still counts as "just before". */
  actionLookbackMs?: number;
  /** How far back a character label is still offered for reuse. */
  characterLookbackMs?: number;
  /** How long a setting stays current without being restated. */
  settingLifetimeMs?: number;
  maxActions?: number;
  maxCharacters?: number;
}

const DEFAULTS: Required<ContinuityOptions> = {
  actionLookbackMs: 12_000,
  characterLookbackMs: 90_000,
  settingLifetimeMs: 180_000,
  maxActions: 3,
  maxCharacters: 8,
};

/** Upper bound on remembered entries, so a feature film stays flat in memory. */
const MAX_ENTRIES = 300;

export class ContinuityTracker {
  #actions: Timed[] = [];
  #settings: Timed[] = [];
  #characters: Timed[] = [];
  #options: Required<ContinuityOptions>;

  constructor(options: ContinuityOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  /** Records what a window reported. Offsets are relative to `window.start`. */
  observe(window: { start: MediaTimeMs; end: MediaTimeMs }, analysis: VisionWindowAnalysis): void {
    const span = Math.max(0, window.end - window.start);
    const at = (offset: number) => window.start + Math.min(Math.max(offset, 0), span);

    for (const action of analysis.actions) {
      const text = action.description.trim();
      if (text) this.#actions.push({ at: at(action.offsetMs), text });
    }
    for (const setting of analysis.settingChanges) {
      const text = [
        setting.interiorExterior && setting.interiorExterior !== 'UNKNOWN'
          ? setting.interiorExterior
          : '',
        setting.description.trim(),
        setting.timeOfDay ?? '',
      ]
        .filter((part) => part.length > 0)
        .join(' ')
        .trim();
      if (text) this.#settings.push({ at: window.start, text });
    }
    for (const character of analysis.characters) {
      const text = character.label.trim();
      if (text && character.present) this.#characters.push({ at: window.start, text });
    }

    for (const list of [this.#actions, this.#settings, this.#characters]) {
      list.sort((a, b) => a.at - b.at);
      if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    }
  }

  /** Context for a window starting at `start`, built only from what came before it. */
  contextAt(start: MediaTimeMs): ContinuityContext {
    const o = this.#options;

    const recentActions = this.#actions
      .filter((entry) => entry.at < start && entry.at >= start - o.actionLookbackMs)
      .slice(-o.maxActions)
      .map((entry) => entry.text);

    const setting = [...this.#settings]
      .reverse()
      .find((entry) => entry.at <= start && entry.at >= start - o.settingLifetimeMs);

    const labels: string[] = [];
    for (const entry of [...this.#characters].reverse()) {
      if (entry.at > start) continue;
      if (entry.at < start - o.characterLookbackMs) break;
      if (!labels.includes(entry.text)) labels.push(entry.text);
      if (labels.length >= o.maxCharacters) break;
    }

    return {
      ...(setting ? { currentSetting: setting.text } : {}),
      knownCharacters: labels.map((label) => ({ id: label, displayName: label })),
      ...(recentActions.length > 0 ? { recentActions } : {}),
    };
  }

  clear(): void {
    this.#actions = [];
    this.#settings = [];
    this.#characters = [];
  }
}
