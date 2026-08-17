/**
 * YouTube quality control.
 *
 * Operates the real player UI: open the settings menu, read what the player
 * actually offers, pick the best entry within the user's preference, click it,
 * then verify.
 *
 * It does not use the deprecated IFrame API quality methods, and it does not
 * touch the player's private JavaScript. Everything it does is something the
 * viewer could do by hand, which is also why it can never obtain a
 * representation the account is not entitled to.
 */

import { DisposableStore, sleep, waitForCondition } from '../../utils/lifecycle';
import { FrameScriptError } from '../../utils/errors';
import { parseQualityOption } from '../../quality/parser';
import { selectQualityOption, verifyApplied } from '../../quality/ranking';
import type {
  QualityApplyResult,
  QualityCapabilities,
  QualityPreference,
  VideoQualityOption,
} from '../../quality/types';
import {
  findQualityMenuItem,
  isSettingsMenuOpen,
  parseQualityMenuItems,
  queryFirst,
  YOUTUBE_SELECTORS,
} from './selectors';

export interface QualityControllerOptions {
  /** Injected for tests; defaults to the live document. */
  root?: ParentNode;
  /** Delay after a click before the menu is expected to have rendered. */
  menuSettleMs?: number;
  /** How long to wait for the player to actually switch representation. */
  verifyTimeoutMs?: number;
}

const DEFAULTS = { menuSettleMs: 120, verifyTimeoutMs: 4_000 } as const;

export class YouTubeQualityController {
  #root: ParentNode;
  #menuSettleMs: number;
  #verifyTimeoutMs: number;
  #store = new DisposableStore();

  /** True while *we* are driving the menu, used to distinguish user clicks. */
  #applying = false;
  #userOverridden = false;
  #onManualChange: (() => void) | null = null;

  constructor(options: QualityControllerOptions = {}) {
    this.#root = options.root ?? document;
    this.#menuSettleMs = options.menuSettleMs ?? DEFAULTS.menuSettleMs;
    this.#verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULTS.verifyTimeoutMs;
  }

  get userOverridden(): boolean {
    return this.#userOverridden;
  }

  /** Clears the per-video override. Called on navigation to new content. */
  resetOverride(): void {
    this.#userOverridden = false;
  }

  /**
   * Watches for the viewer choosing a quality themselves.
   *
   * FrameScript must not fight the viewer: once they pick a quality on this
   * video, automatic selection stands down until the next video.
   */
  watchForManualChanges(onManualChange: () => void): void {
    this.#onManualChange = onManualChange;
    const player = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.player, this.#root);
    if (!player) return;

    this.#store.addEventListener(
      player,
      'click',
      (event) => {
        if (this.#applying) return;
        const target = event.target as Element | null;
        if (!target?.closest) return;
        const row = target.closest('.ytp-menuitem[role="menuitemradio"]');
        if (!row) return;
        // A radio row inside the settings popup that we did not click.
        this.#userOverridden = true;
        this.#onManualChange?.();
      },
      { capture: true },
    );
  }

  /** Reads the quality menu without changing anything. */
  async getCapabilities(): Promise<QualityCapabilities> {
    const openedByUs = await this.#openQualityMenu();
    try {
      const entries = parseQualityMenuItems(this.#root);
      if (entries.length === 0) {
        return { options: [], platformAuto: false, menuReadable: false };
      }

      const options = entries.map((entry, index) =>
        parseQualityOption({
          id: `yt-${index}-${entry.label}`,
          label: entry.label,
          selectable: entry.selectable,
          active: entry.active,
        }),
      );
      const active = options.find((o) => o.active);
      return {
        options,
        ...(active ? { activeOptionId: active.id } : {}),
        platformAuto: active?.auto ?? false,
        menuReadable: true,
      };
    } finally {
      if (openedByUs) await this.#closeMenu();
    }
  }

  /**
   * Applies the best available quality within `preference`.
   *
   * Returns an honest result in every branch: `platform-limited` when the video
   * simply does not offer what was asked for, `user-overridden` when the viewer
   * has taken control, and a failed verification rather than a false success
   * when the player did not move.
   */
  async apply(preference: QualityPreference): Promise<QualityApplyResult> {
    if (this.#userOverridden) {
      return {
        state: 'user-overridden',
        verified: false,
        message: 'You selected a quality for this video, so FrameScript is leaving it alone.',
      };
    }
    if (preference.id === 'platform-auto') {
      return { state: 'idle', verified: false, message: 'Automatic quality selection is disabled.' };
    }

    this.#applying = true;
    try {
      const opened = await this.#openQualityMenu();
      if (!opened) {
        throw new FrameScriptError({ code: 'QUALITY_MENU_NOT_FOUND', detail: 'quality submenu did not open' });
      }

      const entries = parseQualityMenuItems(this.#root);
      if (entries.length === 0) {
        await this.#closeMenu();
        throw new FrameScriptError({ code: 'QUALITY_MENU_NOT_FOUND', detail: 'no quality rows found' });
      }

      const options = entries.map((entry, index) =>
        parseQualityOption({
          id: `yt-${index}-${entry.label}`,
          label: entry.label,
          selectable: entry.selectable,
          active: entry.active,
        }),
      );
      const selection = selectQualityOption(options, preference);
      if (!selection.option) {
        await this.#closeMenu();
        return {
          state: 'platform-limited',
          verified: false,
          limitedBy: 'availability',
          message: 'This video does not offer a selectable fixed quality.',
        };
      }

      const index = options.indexOf(selection.option);
      const entry = entries[index];
      if (!entry) {
        await this.#closeMenu();
        throw new FrameScriptError({ code: 'QUALITY_OPTION_NOT_FOUND', detail: selection.option.label });
      }

      // Already there: clicking would close the menu for no reason.
      if (entry.active) {
        await this.#closeMenu();
        return this.#buildResult(selection.option, selection.option, true, selection.limitedBy);
      }

      entry.element.click();
      await sleep(this.#menuSettleMs);
      await this.#closeMenu();

      const applied = await this.#verify(selection.option);
      return this.#buildResult(selection.option, applied.option, applied.verified, selection.limitedBy, applied.message);
    } finally {
      this.#applying = false;
    }
  }

  dispose(): void {
    this.#store.dispose();
    this.#store = new DisposableStore();
  }

  // --- internals ------------------------------------------------------------

  /** Opens settings and drills into Quality. Returns false if it could not. */
  async #openQualityMenu(): Promise<boolean> {
    const settingsButton = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.settingsButton, this.#root);
    if (!settingsButton) return false;

    if (!isSettingsMenuOpen(this.#root)) {
      settingsButton.click();
      await sleep(this.#menuSettleMs);
    }

    // Already inside the quality submenu?
    if (parseQualityMenuItems(this.#root).length > 0) return true;

    const qualityRow = findQualityMenuItem(this.#root);
    if (!qualityRow) return false;
    qualityRow.click();

    try {
      await waitForCondition(() => parseQualityMenuItems(this.#root).length > 0, {
        timeoutMs: 1_500,
        pollMs: 50,
      });
      return true;
    } catch {
      return false;
    }
  }

  async #closeMenu(): Promise<void> {
    if (!isSettingsMenuOpen(this.#root)) return;
    const settingsButton = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.settingsButton, this.#root);
    settingsButton?.click();
    await sleep(this.#menuSettleMs);
  }

  /**
   * Confirms the player actually switched.
   *
   * Verification uses the media element's `videoHeight`, which is the decoded
   * frame size — the real answer — rather than re-reading the menu label, which
   * would only tell us what we clicked. Adaptive streaming takes a moment to
   * switch representation, hence the wait.
   */
  async #verify(
    requested: VideoQualityOption,
  ): Promise<{ option?: VideoQualityOption; verified: boolean; message?: string }> {
    const video = queryFirst<HTMLVideoElement>(YOUTUBE_SELECTORS.video, this.#root);
    if (!video || !requested.resolution) {
      return { verified: false, message: 'Quality was selected but could not be confirmed.' };
    }

    try {
      await waitForCondition(
        () => video.videoHeight >= requested.resolution! * 0.9 && video.videoHeight > 0,
        { timeoutMs: this.#verifyTimeoutMs, pollMs: 200 },
      );
      const observed = parseQualityOption({ id: 'observed', label: `${video.videoHeight}p` });
      const check = verifyApplied(requested, { ...observed, enhancedBitrate: requested.enhancedBitrate });
      return { option: observed, verified: check.verified, ...(check.message ? { message: check.message } : {}) };
    } catch {
      // Not a failure to report loudly: the network may simply not sustain the
      // higher representation yet, and the player will climb to it on its own.
      const observed =
        video.videoHeight > 0 ? parseQualityOption({ id: 'observed', label: `${video.videoHeight}p` }) : undefined;
      return {
        ...(observed ? { option: observed } : {}),
        verified: false,
        message: `Selected ${requested.label}; the player is currently decoding ${
          video.videoHeight > 0 ? `${video.videoHeight}p` : 'an unknown size'
        }.`,
      };
    }
  }

  #buildResult(
    requested: VideoQualityOption,
    applied: VideoQualityOption | undefined,
    verified: boolean,
    limitedBy: QualityApplyResult['limitedBy'],
    message?: string,
  ): QualityApplyResult {
    const state: QualityApplyResult['state'] = limitedBy && limitedBy !== 'preference' ? 'platform-limited' : 'best-available';
    return {
      state,
      requested,
      ...(applied ? { applied } : {}),
      verified,
      ...(limitedBy ? { limitedBy } : {}),
      ...(message ? { message } : {}),
    };
  }
}
