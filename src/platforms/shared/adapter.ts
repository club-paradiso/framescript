/**
 * The streaming platform interface.
 *
 * Everything platform-specific lives behind this. No YouTube selector and no
 * Netflix selector appears anywhere in core code — if one ever does, the
 * multilingual engine, the temporal engine and the screenplay engine become
 * un-testable without a live streaming session.
 */

import type { MediaTimeMs } from '../../utils/time';
import type {
  ContentIdentity,
  PlatformId,
  PlayerState,
  SubtitleLanguage,
} from '../../messaging/protocol';
import type { QualityApplyResult, QualityCapabilities, QualityPreference } from '../../quality/types';
import type { RawSubtitleObservation } from '../../capture/subtitle/normalize';

export interface SubtitleLanguageSelectionResult {
  ok: boolean;
  /** The language actually active afterwards, which may differ from the request. */
  active?: SubtitleLanguage;
  message?: string;
}

export interface StreamingPlatformAdapter {
  readonly id: PlatformId;

  matches(url: URL): boolean;
  initialize(): Promise<void>;
  dispose(): Promise<void>;

  getContentIdentity(): Promise<ContentIdentity | null>;
  getPlayerState(): Promise<PlayerState>;
  getCurrentTime(): MediaTimeMs | null;
  getDuration(): MediaTimeMs | null;
  seekTo(ms: MediaTimeMs): Promise<boolean>;

  /** The media element, when the platform exposes an accessible one. */
  getMediaElement(): HTMLVideoElement | null;

  getAvailableSubtitleLanguages(): Promise<SubtitleLanguage[]>;
  getActiveSubtitleLanguage(): Promise<SubtitleLanguage | null>;
  requestSubtitleLanguage(languageId: string): Promise<SubtitleLanguageSelectionResult>;

  startSubtitleObservation(callback: (event: RawSubtitleObservation) => void): Promise<void>;
  stopSubtitleObservation(): Promise<void>;

  getQualityCapabilities(): Promise<QualityCapabilities>;
  applyMaximumQuality(preference: QualityPreference): Promise<QualityApplyResult>;

  /** Fires when the SPA navigates to different content. */
  onContentChange(callback: (identity: ContentIdentity | null) => void): () => void;
  /** Fires when the viewer changes quality by hand. */
  onManualQualityChange(callback: () => void): () => void;
}

/** Chooses the adapter for a URL, or null when the page is not supported. */
export function selectAdapter<T extends StreamingPlatformAdapter>(
  adapters: readonly T[],
  url: URL,
): T | null {
  return adapters.find((adapter) => adapter.matches(url)) ?? null;
}
