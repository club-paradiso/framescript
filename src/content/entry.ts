/**
 * Content script entry point.
 *
 * Runs in the page's isolated world on YouTube and Netflix. It owns:
 *   - the platform adapter lifecycle across SPA navigation,
 *   - Maximum Quality application and re-application,
 *   - subtitle observation and normalization,
 *   - playback evidence (play/pause/seek/rate/resize).
 *
 * It deliberately does NOT do heavy media analysis. Audio and picture analysis
 * happen in the offscreen document, where they cannot compete with the page's
 * own rendering work.
 */

import { createIdFactory } from '../utils/id';
import { DisposableStore, debounce } from '../utils/lifecycle';
import { secondsToMs, type MediaTimeMs } from '../utils/time';
import { errorDetail, describeError, FrameScriptError } from '../utils/errors';
import { QUALITY_PREFERENCES, type QualityPreference, type QualityPreferenceId } from '../quality/types';
import type { EvidenceEvent, PlaybackEvidence, SubtitleEvidence } from '../evidence/types';
import { SubtitleAccumulator, type NormalizedCue } from '../capture/subtitle/normalize';
import { isNonSpeechCaption } from '../characters/attribution';
import { onRuntimeMessage, sendRuntime } from '../messaging/bus';
import type { ContentIdentity, QualityStatus, WorkerToContent } from '../messaging/protocol';
import { observeMediaEvents, observeVideoReplacement } from '../platforms/shared/media';
import type { StreamingPlatformAdapter } from '../platforms/shared/adapter';
import { YouTubeAdapter } from '../platforms/youtube/YouTubeAdapter';
import { NetflixAdapter } from '../platforms/netflix/NetflixAdapter';
import { DEFAULT_SETTINGS, type FrameScriptSettings } from '../settings/types';
import { settingsStore } from '../settings/store';

const nextEvidenceId = createIdFactory('ev');

class ContentController {
  #adapter: StreamingPlatformAdapter | null = null;
  #store = new DisposableStore();
  #mediaStore: DisposableStore | null = null;
  #accumulator = new SubtitleAccumulator();
  #settings: FrameScriptSettings = DEFAULT_SETTINGS;
  #identity: ContentIdentity | null = null;
  #subtitlesActive = false;
  #qualityStatus: QualityStatus | null = null;
  #disposed = false;

  async start(): Promise<void> {
    const url = new URL(location.href);
    const adapter = this.#createAdapter(url);
    if (!adapter) return;

    this.#adapter = adapter;
    this.#settings = await settingsStore.get();
    this.#store.add(
      settingsStore.subscribe((settings) => {
        this.#settings = settings;
        void this.#applyQuality();
      }),
    );

    await adapter.initialize();
    this.#store.add(() => void adapter.dispose());

    this.#store.add(
      adapter.onContentChange((identity) => {
        void this.#handleContentChange(identity);
      }),
    );
    this.#store.add(
      adapter.onManualQualityChange(() => {
        void this.#reportQuality({ userOverridden: true });
      }),
    );

    this.#store.add(onRuntimeMessage<WorkerToContent>((message) => this.#handleMessage(message)));

    await sendRuntime({ type: 'content/ready', payload: { platform: adapter.id, url: location.href } });

    await this.#handleContentChange(await adapter.getContentIdentity());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mediaStore?.dispose();
    this.#store.dispose();
  }

  #createAdapter(url: URL): StreamingPlatformAdapter | null {
    const candidates: StreamingPlatformAdapter[] = [new YouTubeAdapter(), new NetflixAdapter()];
    return candidates.find((adapter) => adapter.matches(url)) ?? null;
  }

  /**
   * Handles arriving at new content.
   *
   * Order matters: tear down the previous video's observers first, then attach
   * to the new media element, then apply quality. Attaching before teardown is
   * how duplicate observers accumulate across a playlist.
   */
  async #handleContentChange(identity: ContentIdentity | null): Promise<void> {
    this.#identity = identity;
    this.#mediaStore?.dispose();
    this.#mediaStore = null;
    this.#accumulator.reset();

    await sendRuntime({ type: 'content/identity', payload: identity });
    if (!identity || !this.#adapter) return;

    await this.#attachToMedia();
    await this.#applyQuality();
    await this.#reportSubtitleLanguages();

    if (this.#subtitlesActive) await this.#startSubtitles();
  }

  async #attachToMedia(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter) return;
    const video = adapter.getMediaElement();
    if (!video) return;

    const store = new DisposableStore();
    this.#mediaStore = store;

    const reportState = debounce(() => {
      void adapter.getPlayerState().then((state) => sendRuntime({ type: 'content/player-state', payload: state }));
    }, 200);
    store.add(() => reportState.cancel());

    store.add(
      observeMediaEvents(video, {
        onPlay: () => {
          this.#emitPlayback('play', video);
          reportState();
        },
        onPause: () => {
          this.#emitPlayback('pause', video);
          // A pause is a natural cue boundary; hold nothing half-open.
          this.#flushSubtitles();
          reportState();
        },
        onSeeked: (from, to) => {
          this.#flushSubtitles();
          this.#emitPlayback('seek', video, { fromTime: from, at: to });
          reportState();
        },
        onRateChange: (rate) => this.#emitPlayback('rate-change', video, { playbackRate: rate }),
        onEnded: () => {
          this.#flushSubtitles();
          this.#emitPlayback('ended', video);
        },
        onStalled: () => this.#emitPlayback('stall', video),
        onResize: (width, height) => this.#emitPlayback('resize', video, { videoWidth: width, videoHeight: height }),
        onDurationChange: () => reportState(),
      }),
    );

    // The player element is replaced on navigation; re-attach when it is.
    store.add(
      observeVideoReplacement(video, () => {
        void this.#attachToMedia();
      }),
    );

    reportState();
  }

  async #applyQuality(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter) return;

    if (!this.#settings.playback.maximumQualityEnabled) {
      await this.#reportQuality({ state: 'idle' });
      return;
    }
    if (adapter.id === 'netflix' && !this.#settings.playback.netflixQualityGuard) {
      await this.#reportQuality({ state: 'idle' });
      return;
    }

    const preferenceId = this.#settings.playback.youtubeQuality as QualityPreferenceId;
    const preference: QualityPreference = {
      ...QUALITY_PREFERENCES[preferenceId],
      preferEnhancedBitrate: this.#settings.playback.preferEnhancedBitrate,
    };

    await this.#reportQuality({ state: 'applying' });
    try {
      const result = await adapter.applyMaximumQuality(preference);
      const capabilities = await adapter.getQualityCapabilities().catch(() => undefined);
      await this.#reportQuality({
        state: result.state,
        result,
        ...(capabilities ? { capabilities } : {}),
      });
    } catch (err) {
      const described = describeError(err);
      console.warn('[FrameScript] quality application failed:', errorDetail(err));
      await this.#reportQuality({ state: 'error' });
      await sendRuntime({
        type: 'content/error',
        payload: { code: described.code, message: described.message },
      });
    }
  }

  async #reportQuality(patch: Partial<QualityStatus> & { state?: QualityStatus['state'] }): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter) return;

    const next: QualityStatus = {
      state: patch.state ?? this.#qualityStatus?.state ?? 'idle',
      platform: adapter.id,
      userOverridden: patch.userOverridden ?? this.#qualityStatus?.userOverridden ?? false,
      ...(patch.capabilities ? { capabilities: patch.capabilities } : {}),
      ...(patch.result ? { result: patch.result } : {}),
    };

    if (adapter instanceof NetflixAdapter) {
      next.netflix = adapter.getNetflixReport();
    }
    this.#qualityStatus = next;
    await sendRuntime({ type: 'content/quality', payload: next });
  }

  async #reportSubtitleLanguages(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter) return;
    const languages = await adapter.getAvailableSubtitleLanguages().catch(() => []);
    await sendRuntime({ type: 'content/subtitle-languages', payload: { languages } });
  }

  async #startSubtitles(): Promise<void> {
    const adapter = this.#adapter;
    if (!adapter) return;

    try {
      await adapter.startSubtitleObservation((observation) => {
        const cues = this.#accumulator.observe(observation);
        for (const cue of cues) this.#emitSubtitle(cue);
      });
      this.#subtitlesActive = true;
    } catch (err) {
      this.#subtitlesActive = false;
      const described = describeError(err);
      // Not a crash: subtitles are simply off, and the screenplay continues
      // from audio and picture.
      await sendRuntime({
        type: 'content/error',
        payload: { code: described.code, message: described.message },
      });
    }
  }

  #flushSubtitles(): void {
    const cue = this.#accumulator.flush();
    if (cue) this.#emitSubtitle(cue);
  }

  #emitSubtitle(cue: NormalizedCue): void {
    const nonSpeech = isNonSpeechCaption(cue.text);
    const event: SubtitleEvidence = {
      id: nextEvidenceId(),
      source: 'subtitle',
      start: cue.start,
      end: cue.end,
      // An authored caption track is strong evidence; an auto-generated one is
      // machine transcription and is recorded as one step less certain.
      confidence: cue.autoGenerated ? 'medium' : 'high',
      provisional: false,
      payload: {
        text: cue.text,
        language: cue.language,
        raw: cue.raw,
        ...(nonSpeech ? { nonSpeech: true } : {}),
        ...(cue.autoGenerated ? { autoGenerated: true } : {}),
      },
    };
    this.#emitEvidence([event]);
  }

  #emitPlayback(
    kind: PlaybackEvidence['payload']['kind'],
    video: HTMLVideoElement,
    extra: {
      fromTime?: MediaTimeMs;
      at?: MediaTimeMs;
      playbackRate?: number;
      videoWidth?: number;
      videoHeight?: number;
    } = {},
  ): void {
    const event: PlaybackEvidence = {
      id: nextEvidenceId(),
      source: 'playback',
      start: extra.at ?? secondsToMs(video.currentTime),
      confidence: 'high',
      provisional: false,
      payload: {
        kind,
        ...(extra.fromTime === undefined ? {} : { fromTime: extra.fromTime }),
        ...(extra.playbackRate === undefined ? {} : { playbackRate: extra.playbackRate }),
        ...(extra.videoWidth === undefined ? {} : { videoWidth: extra.videoWidth }),
        ...(extra.videoHeight === undefined ? {} : { videoHeight: extra.videoHeight }),
      },
    };
    this.#emitEvidence([event]);
  }

  #emitEvidence(events: EvidenceEvent[]): void {
    void sendRuntime({ type: 'content/evidence', payload: { events } });
  }

  async #handleMessage(message: WorkerToContent): Promise<unknown> {
    switch (message.type) {
      case 'worker/apply-quality':
        await this.#applyQuality();
        return { ok: true };

      case 'worker/start-subtitles':
        await this.#startSubtitles();
        await this.#reportSubtitleLanguages();
        return { ok: this.#subtitlesActive };

      case 'worker/stop-subtitles':
        this.#flushSubtitles();
        await this.#adapter?.stopSubtitleObservation();
        this.#subtitlesActive = false;
        return { ok: true };

      case 'worker/request-state': {
        const state = await this.#adapter?.getPlayerState();
        return { identity: this.#identity, state, quality: this.#qualityStatus };
      }

      case 'worker/seek': {
        const ok = (await this.#adapter?.seekTo(message.payload.toMs)) ?? false;
        return { ok };
      }

      case 'worker/set-subtitle-language': {
        const result = await this.#adapter?.requestSubtitleLanguage(message.payload.languageId);
        return result ?? { ok: false };
      }

      case 'worker/settings-changed':
        this.#settings = message.payload.settings;
        await this.#applyQuality();
        return { ok: true };

      default:
        return undefined;
    }
  }
}

const controller = new ContentController();
controller.start().catch((err: unknown) => {
  // Never let a startup failure leave a half-attached observer behind.
  console.error('[FrameScript] content script failed to start:', errorDetail(err));
  controller.dispose();
  if (FrameScriptError.is(err)) {
    void sendRuntime({
      type: 'content/error',
      payload: { code: err.code, message: describeError(err).message },
    });
  }
});

window.addEventListener('pagehide', () => controller.dispose(), { once: true });
