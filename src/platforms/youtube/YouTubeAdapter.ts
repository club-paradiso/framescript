/**
 * YouTube platform adapter.
 *
 * Ties the quality controller, the caption observer and navigation handling
 * into the shared `StreamingPlatformAdapter` contract.
 */

import { DisposableStore, waitForCondition } from '../../utils/lifecycle';
import { msToSeconds, secondsToMs, type MediaTimeMs } from '../../utils/time';
import { FrameScriptError } from '../../utils/errors';
import type { ContentIdentity, PlayerState, SubtitleLanguage } from '../../messaging/protocol';
import type { QualityApplyResult, QualityCapabilities, QualityPreference } from '../../quality/types';
import type { RawSubtitleObservation } from '../../capture/subtitle/normalize';
import type { StreamingPlatformAdapter, SubtitleLanguageSelectionResult } from '../shared/adapter';
import { findPrimaryVideo, readPlayerState } from '../shared/media';
import { observeUrlChanges, parseYouTubeVideoId } from '../shared/navigation';
import { queryAll, queryFirst, YOUTUBE_SELECTORS } from './selectors';
import { YouTubeQualityController } from './YouTubeQualityController';
import { YouTubeSubtitleObserver } from './YouTubeSubtitleObserver';

export class YouTubeAdapter implements StreamingPlatformAdapter {
  readonly id = 'youtube' as const;

  #store = new DisposableStore();
  #quality = new YouTubeQualityController();
  #subtitles = new YouTubeSubtitleObserver();
  #contentListeners = new Set<(identity: ContentIdentity | null) => void>();
  #manualQualityListeners = new Set<() => void>();
  #currentVideoId: string | null = null;

  matches(url: URL): boolean {
    return url.hostname.endsWith('youtube.com') || url.hostname === 'youtu.be';
  }

  async initialize(): Promise<void> {
    this.#currentVideoId = parseYouTubeVideoId(new URL(location.href));

    this.#store.add(
      observeUrlChanges(
        () => void this.#handleNavigation(),
        // YouTube's own navigation event fires reliably once the new page is
        // committed, which is earlier and more accurate than our fallbacks.
        { customEvents: ['yt-navigate-finish', 'yt-page-data-updated'] },
      ),
    );

    this.#quality.watchForManualChanges(() => {
      for (const listener of this.#manualQualityListeners) listener();
    });
  }

  async dispose(): Promise<void> {
    this.#subtitles.stop();
    this.#quality.dispose();
    this.#store.dispose();
    this.#store = new DisposableStore();
    this.#contentListeners.clear();
    this.#manualQualityListeners.clear();
  }

  getMediaElement(): HTMLVideoElement | null {
    return queryFirst<HTMLVideoElement>(YOUTUBE_SELECTORS.video) ?? findPrimaryVideo();
  }

  async getContentIdentity(): Promise<ContentIdentity | null> {
    const url = new URL(location.href);
    const contentId = parseYouTubeVideoId(url);
    if (!contentId) return null;

    const identity: ContentIdentity = { platform: 'youtube', contentId, url: url.href };
    const title = this.#readTitle();
    if (title) identity.title = title;

    const video = this.getMediaElement();
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      identity.durationMs = secondsToMs(video.duration);
    }
    return identity;
  }

  async getPlayerState(): Promise<PlayerState> {
    return readPlayerState(this.getMediaElement());
  }

  getCurrentTime(): MediaTimeMs | null {
    const video = this.getMediaElement();
    return video ? secondsToMs(video.currentTime) : null;
  }

  getDuration(): MediaTimeMs | null {
    const video = this.getMediaElement();
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
    return secondsToMs(video.duration);
  }

  async seekTo(ms: MediaTimeMs): Promise<boolean> {
    const video = this.getMediaElement();
    if (!video) return false;
    try {
      video.currentTime = msToSeconds(ms);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Enumerates caption tracks.
   *
   * Read from the settings menu the same way the quality menu is read. When
   * captions are switched off entirely the list is empty, which is reported
   * plainly rather than as a failure.
   */
  async getAvailableSubtitleLanguages(): Promise<SubtitleLanguage[]> {
    const active = this.#readActiveCaptionLabel();
    if (!active) return [];
    return [
      {
        id: active,
        label: active,
        source: /auto|자동|自動/i.test(active) ? 'auto-generated' : 'platform',
        isActive: true,
      },
    ];
  }

  async getActiveSubtitleLanguage(): Promise<SubtitleLanguage | null> {
    const languages = await this.getAvailableSubtitleLanguages();
    return languages.find((l) => l.isActive) ?? null;
  }

  /**
   * Switching caption tracks requires driving YouTube's subtitles submenu.
   *
   * Not implemented rather than half-implemented: FrameScript reads whichever
   * track the viewer has chosen, and says so, instead of silently failing to
   * switch and then mislabelling the evidence's language.
   */
  async requestSubtitleLanguage(_languageId: string): Promise<SubtitleLanguageSelectionResult> {
    const active = await this.getActiveSubtitleLanguage();
    return {
      ok: false,
      ...(active ? { active } : {}),
      message:
        'FrameScript reads the subtitle track you have selected in the player. Change it in the player to capture a different language.',
    };
  }

  async startSubtitleObservation(callback: (event: RawSubtitleObservation) => void): Promise<void> {
    const label = this.#readActiveCaptionLabel();
    this.#subtitles.setLanguage(languageCodeFromLabel(label), /auto|자동|自動/i.test(label ?? ''));

    const started = await this.#subtitles.start(callback);
    if (!started) {
      throw new FrameScriptError({
        code: 'CAPTION_CONTAINER_NOT_FOUND',
        detail: 'caption container never appeared',
      });
    }
  }

  async stopSubtitleObservation(): Promise<void> {
    this.#subtitles.stop();
  }

  async getQualityCapabilities(): Promise<QualityCapabilities> {
    await this.#waitForPlayer();
    return this.#quality.getCapabilities();
  }

  async applyMaximumQuality(preference: QualityPreference): Promise<QualityApplyResult> {
    await this.#waitForPlayer();
    return this.#quality.apply(preference);
  }

  onContentChange(callback: (identity: ContentIdentity | null) => void): () => void {
    this.#contentListeners.add(callback);
    return () => this.#contentListeners.delete(callback);
  }

  onManualQualityChange(callback: () => void): () => void {
    this.#manualQualityListeners.add(callback);
    return () => this.#manualQualityListeners.delete(callback);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Waits for a player that has actually loaded metadata.
   *
   * Reading the quality menu before metadata is available returns an empty or
   * partial list, which is how "FrameScript picked 360p" happens.
   */
  async #waitForPlayer(): Promise<HTMLVideoElement> {
    return waitForCondition(
      () => {
        const video = this.getMediaElement();
        return video && video.readyState >= 1 ? video : null;
      },
      { timeoutMs: 15_000, pollMs: 200 },
    ).catch(() => {
      throw new FrameScriptError({ code: 'PLAYER_NOT_FOUND', detail: 'player did not become ready' });
    });
  }

  /**
   * Handles SPA navigation.
   *
   * Same video id (a playlist advancing to the same clip, a query-string
   * change) is not a content change and must not reset the manual override —
   * that would make FrameScript override the viewer's own choice.
   */
  async #handleNavigation(): Promise<void> {
    const nextId = parseYouTubeVideoId(new URL(location.href));
    if (nextId === this.#currentVideoId) return;

    this.#currentVideoId = nextId;
    this.#subtitles.stop();
    this.#quality.resetOverride();
    this.#quality.dispose();
    this.#quality = new YouTubeQualityController();
    this.#quality.watchForManualChanges(() => {
      for (const listener of this.#manualQualityListeners) listener();
    });

    const identity = await this.getContentIdentity();
    for (const listener of this.#contentListeners) listener(identity);
  }

  #readTitle(): string | null {
    for (const selector of YOUTUBE_SELECTORS.title) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const text =
        node instanceof HTMLMetaElement ? node.content : (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return null;
  }

  /** The caption track label shown on the settings row, when captions are on. */
  #readActiveCaptionLabel(): string | null {
    const menuItems = queryAll<HTMLElement>(YOUTUBE_SELECTORS.menuItem);
    for (const item of menuItems) {
      const label = queryFirst(YOUTUBE_SELECTORS.menuItemLabel, item)?.textContent ?? '';
      const content = queryFirst(YOUTUBE_SELECTORS.menuItemContent, item)?.textContent ?? '';
      if (/subtitle|caption|자막|字幕|subtítulo|untertitel/i.test(label)) {
        const value = content.replace(/\s+/g, ' ').trim();
        return value && !/^(off|없음|オフ|desactivado)$/i.test(value) ? value : null;
      }
    }
    // Menu closed: fall back to whether the caption toggle reports enabled.
    return this.#subtitles.captionsEnabled() ? 'unknown' : null;
  }
}

/**
 * Maps a caption menu label to a language code.
 *
 * Deliberately conservative: an unrecognised label becomes `und` (undetermined)
 * rather than a guess, because mislabelling a Korean track as English would
 * silently corrupt the multilingual screenplay.
 */
export function languageCodeFromLabel(label: string | null): string {
  if (!label) return 'und';
  const normalized = label.toLowerCase();
  const table: Record<string, string> = {
    english: 'en',
    korean: 'ko',
    한국어: 'ko',
    japanese: 'ja',
    日本語: 'ja',
    spanish: 'es',
    español: 'es',
    french: 'fr',
    français: 'fr',
    german: 'de',
    deutsch: 'de',
    portuguese: 'pt',
    português: 'pt',
    italian: 'it',
    italiano: 'it',
    chinese: 'zh',
    中文: 'zh',
    hindi: 'hi',
    arabic: 'ar',
    russian: 'ru',
    русский: 'ru',
  };
  for (const [name, code] of Object.entries(table)) {
    if (normalized.includes(name)) return code;
  }
  const bcp47 = /\b([a-z]{2})(?:-[a-z]{2})?\b/i.exec(label);
  return bcp47 ? bcp47[1]!.toLowerCase() : 'und';
}
