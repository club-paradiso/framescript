/**
 * Settings persistence on `chrome.storage.local`.
 *
 * `local` rather than `sync` deliberately: API keys must not be replicated
 * across a user's other machines by the browser without them asking.
 */

import { DEFAULT_SETTINGS, mergeSettings, type FrameScriptSettings } from './types';
import { FrameScriptError } from '../utils/errors';

const STORAGE_KEY = 'framescript:settings';

export type SettingsListener = (settings: FrameScriptSettings) => void;

export class SettingsStore {
  #cache: FrameScriptSettings | null = null;
  #listeners = new Set<SettingsListener>();
  #changeHandler: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null =
    null;

  async get(): Promise<FrameScriptSettings> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      this.#cache = mergeSettings(raw[STORAGE_KEY] as Partial<FrameScriptSettings> | undefined);
    } catch (err) {
      // A storage failure must not brick the extension; fall back to defaults.
      console.error('[FrameScript] failed to read settings', err);
      this.#cache = mergeSettings(undefined);
    }
    return this.#cache;
  }

  /** Applies a partial update and broadcasts the merged result. */
  async update(patch: DeepPartial<FrameScriptSettings>): Promise<FrameScriptSettings> {
    const current = await this.get();
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const next = mergeSettings(merged as Partial<FrameScriptSettings>);
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    } catch (err) {
      throw new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'settings write failed', cause: err });
    }
    this.#cache = next;
    this.#emit(next);
    return next;
  }

  async reset(): Promise<FrameScriptSettings> {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
    this.#cache = mergeSettings(DEFAULT_SETTINGS);
    this.#emit(this.#cache);
    return this.#cache;
  }

  /** Subscribes to changes, including those made in another extension context. */
  subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    this.#ensureStorageListener();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#teardownStorageListener();
    };
  }

  #ensureStorageListener(): void {
    if (this.#changeHandler || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    this.#changeHandler = (changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      this.#cache = mergeSettings(changes[STORAGE_KEY]!.newValue as Partial<FrameScriptSettings>);
      this.#emit(this.#cache);
    };
    chrome.storage.onChanged.addListener(this.#changeHandler);
  }

  #teardownStorageListener(): void {
    if (!this.#changeHandler || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.removeListener(this.#changeHandler);
    this.#changeHandler = null;
  }

  #emit(settings: FrameScriptSettings): void {
    for (const listener of this.#listeners) {
      try {
        listener(settings);
      } catch (err) {
        console.error('[FrameScript] settings listener threw', err);
      }
    }
  }
}

export const settingsStore = new SettingsStore();

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function deepMerge<T extends Record<string, unknown>>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
