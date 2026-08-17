/**
 * Netflix platform adapter.
 *
 * Subtitles, timing and metadata work the same way as on YouTube. Quality does
 * not: `applyMaximumQuality` deliberately changes nothing and returns an honest
 * report instead. See `NetflixQualityGuard` for why.
 */

import { DisposableStore, throttle, waitForCondition } from '../../utils/lifecycle';
import { msToSeconds, secondsToMs, type MediaTimeMs } from '../../utils/time';
import { FrameScriptError } from '../../utils/errors';
import type { ContentIdentity, PlayerState, SubtitleLanguage } from '../../messaging/protocol';
import type { QualityApplyResult, QualityCapabilities, QualityPreference } from '../../quality/types';
import type { RawSubtitleObservation } from '../../capture/subtitle/normalize';
import type { StreamingPlatformAdapter, SubtitleLanguageSelectionResult } from '../shared/adapter';
import { findPrimaryVideo, readPlayerState } from '../shared/media';
import { observeUrlChanges, parseNetflixVideoId } from '../shared/navigation';
import { NETFLIX_SELECTORS, parseEpisodeLabel, queryAll, queryFirst } from './selectors';
import { NetflixQualityGuard } from './NetflixQualityGuard';
import { languageCodeFromLabel } from '../youtube/YouTubeAdapter';

export class NetflixAdapter implements StreamingPlatformAdapter {
  readonly id = 'netflix' as const;

  #store = new DisposableStore();
  #subtitleStore = new DisposableStore();
  #guard = new NetflixQualityGuard();
  #contentListeners = new Set<(identity: ContentIdentity | null) => void>();
  #currentVideoId: string | null = null;
  #lastSubtitleText = '';

  matches(url: URL): boolean {
    return url.hostname.endsWith('netflix.com');
  }

  async initialize(): Promise<void> {
    this.#currentVideoId = parseNetflixVideoId(new URL(location.href));
    this.#store.add(observeUrlChanges(() => void this.#handleNavigation()));
  }

  async dispose(): Promise<void> {
    await this.stopSubtitleObservation();
    this.#store.dispose();
    this.#store = new DisposableStore();
    this.#contentListeners.clear();
  }

  getMediaElement(): HTMLVideoElement | null {
    return queryFirst<HTMLVideoElement>(NETFLIX_SELECTORS.video) ?? findPrimaryVideo();
  }

  async getContentIdentity(): Promise<ContentIdentity | null> {
    const url = new URL(location.href);
    const contentId = parseNetflixVideoId(url);
    if (!contentId) return null;

    const identity: ContentIdentity = { platform: 'netflix', contentId, url: url.href };

    const titleNode = queryFirst(NETFLIX_SELECTORS.videoTitle);
    if (titleNode) {
      // The title element holds the series name in its own text and the episode
      // designation in child spans, so read them separately before parsing.
      const spans = [...titleNode.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim()).filter(Boolean);
      const ownText = (titleNode.childNodes[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();

      if (spans.length > 0 && ownText) {
        identity.seriesTitle = ownText;
        const parsed = parseEpisodeLabel(spans.join(' '));
        if (parsed.season !== undefined) identity.season = parsed.season;
        if (parsed.episode !== undefined) identity.episode = parsed.episode;
        if (parsed.title) identity.title = parsed.title;
      } else {
        const full = (titleNode.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (full) identity.title = full;
      }
    }

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

  async getAvailableSubtitleLanguages(): Promise<SubtitleLanguage[]> {
    const options = queryAll<HTMLElement>(NETFLIX_SELECTORS.trackOption);
    if (options.length === 0) return [];

    return options
      .map((option) => {
        const label = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
        const isActive =
          option.getAttribute('aria-checked') === 'true' || option.getAttribute('aria-selected') === 'true';
        return {
          id: label,
          code: languageCodeFromLabel(label),
          label,
          source: /cc|자막 \(cc\)/i.test(label) ? ('platform' as const) : ('platform' as const),
          isActive,
        };
      })
      .filter((l) => l.label.length > 0);
  }

  async getActiveSubtitleLanguage(): Promise<SubtitleLanguage | null> {
    const languages = await this.getAvailableSubtitleLanguages();
    return languages.find((l) => l.isActive) ?? null;
  }

  async requestSubtitleLanguage(_languageId: string): Promise<SubtitleLanguageSelectionResult> {
    const active = await this.getActiveSubtitleLanguage();
    return {
      ok: false,
      ...(active ? { active } : {}),
      message:
        'FrameScript reads the subtitle track you have selected in Netflix. Change it in the player to capture a different language.',
    };
  }

  /**
   * Observes Netflix's timed-text container.
   *
   * Netflix renders subtitles as positioned DOM, not as burned-in pixels, so
   * this reads real text and needs no OCR — which is fortunate, because the
   * picture itself is usually unavailable under protected playback.
   */
  async startSubtitleObservation(callback: (event: RawSubtitleObservation) => void): Promise<void> {
    await this.stopSubtitleObservation();

    let container: Element;
    try {
      container = await waitForCondition(() => queryFirst(NETFLIX_SELECTORS.timedTextContainer), {
        timeoutMs: 10_000,
        pollMs: 250,
      });
    } catch {
      throw new FrameScriptError({
        code: 'CAPTION_CONTAINER_NOT_FOUND',
        detail: 'timed-text container never appeared',
      });
    }

    const active = await this.getActiveSubtitleLanguage();
    const language = active?.code ?? languageCodeFromLabel(active?.label ?? null);
    const video = this.getMediaElement();

    const read = throttle(() => {
      const text = this.#readSubtitleText();
      if (text === this.#lastSubtitleText) return;
      this.#lastSubtitleText = text;
      callback({
        text,
        mediaTime: video ? secondsToMs(video.currentTime) : 0,
        language,
        autoGenerated: false,
      });
    }, 60);

    const observer = new MutationObserver(() => read());
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    this.#subtitleStore.add(() => {
      observer.disconnect();
      read.cancel();
    });
    read();
  }

  async stopSubtitleObservation(): Promise<void> {
    this.#subtitleStore.dispose();
    this.#subtitleStore = new DisposableStore();
    this.#lastSubtitleText = '';
  }

  /**
   * Netflix exposes no selectable quality ladder to the page, so there is
   * nothing to enumerate. Returning an empty, explicitly-unreadable capability
   * set is the truthful answer.
   */
  async getQualityCapabilities(): Promise<QualityCapabilities> {
    return { options: [], platformAuto: true, menuReadable: false };
  }

  /**
   * Does not change Netflix's quality — by design.
   *
   * Returns the guard's honest report so the UI can distinguish environment
   * ceiling, observed stream, and unknown.
   */
  async applyMaximumQuality(_preference: QualityPreference): Promise<QualityApplyResult> {
    const video = this.getMediaElement();
    const report = this.#guard.report(video);
    const summary = this.#guard.summarize(report);

    return {
      state: report.state === 'unsupported' ? 'unsupported' : 'platform-limited',
      verified: false,
      limitedBy: 'unknown',
      message: `Netflix controls its own playback quality. Environment ceiling: ${summary.ceiling}. Current stream: ${summary.current}.`,
    };
  }

  /** The full Netflix report, for the popup and diagnostics. */
  getNetflixReport() {
    return this.#guard.report(this.getMediaElement());
  }

  onContentChange(callback: (identity: ContentIdentity | null) => void): () => void {
    this.#contentListeners.add(callback);
    return () => this.#contentListeners.delete(callback);
  }

  /** Netflix has no in-player quality picker, so there is no manual override. */
  onManualQualityChange(_callback: () => void): () => void {
    return () => {};
  }

  #readSubtitleText(): string {
    const blocks = queryAll(NETFLIX_SELECTORS.timedTextBlock);
    if (blocks.length === 0) {
      const container = queryFirst(NETFLIX_SELECTORS.timedTextContainer);
      return (container?.textContent ?? '').trim();
    }
    // Each block is one rendered line; keep them as lines.
    return blocks
      .map((block) => (block.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  async #handleNavigation(): Promise<void> {
    const nextId = parseNetflixVideoId(new URL(location.href));
    if (nextId === this.#currentVideoId) return;

    this.#currentVideoId = nextId;
    await this.stopSubtitleObservation();
    const identity = await this.getContentIdentity();
    for (const listener of this.#contentListeners) listener(identity);
  }
}
