/**
 * Settings model.
 *
 * Every default here is chosen so that a freshly installed FrameScript does
 * nothing surprising: no telemetry, no remote AI, no media retention, and no
 * media analysis at all until the user starts it.
 */

import type { AnalysisFidelity } from '../temporal/fidelity';
import type { QualityPreferenceId } from '../quality/types';

export interface PlaybackSettings {
  /** Master switch for the Maximum Quality engine. */
  maximumQualityEnabled: boolean;
  youtubeQuality: QualityPreferenceId;
  preferEnhancedBitrate: boolean;
  /** Stop re-applying quality once the viewer picks one themselves. */
  respectManualOverride: boolean;
  /** Netflix best-effort optimization and honest capability reporting. */
  netflixQualityGuard: boolean;
}

export interface SourceToggles {
  subtitles: boolean;
  audio: boolean;
  video: boolean;
  ocr: boolean;
  soundEvents: boolean;
}

export interface AnalysisSettings {
  fidelity: AnalysisFidelity;
  sources: SourceToggles;
  /** Keep analyzing while the tab is in the background. */
  continueWhenHidden: boolean;
}

export interface LanguageSettings {
  /** `system` follows the browser UI language. */
  scriptLanguage: string;
  /** `platform-default` leaves the player's own subtitle choice alone. */
  preferredSubtitleLanguage: string;
  /** Show platform-subtitle dialogue in its original language alongside. */
  showOriginalDialogue: boolean;
  dualLanguageView: boolean;
  /** Second language for the dual view. */
  secondaryLanguage: string;
}

export interface ScreenplaySettings {
  showTimestamps: boolean;
  followPlayback: boolean;
  autoScroll: boolean;
  defaultView: 'dialogue' | 'screenplay' | 'evidence';
  /** Include beats that rest only on low-confidence inference. */
  includeLowConfidence: boolean;
}

export type AiProviderId = 'none' | 'anthropic' | 'openai-compatible';

export interface AiSettings {
  /** Master switch. Off by default; nothing leaves the device while off. */
  remoteEnabled: boolean;
  /** True once the user has read and accepted the data-transmission notice. */
  consentAcknowledged: boolean;
  vision: {
    provider: Extract<AiProviderId, 'none' | 'anthropic'>;
    model: string;
    apiKey: string;
    baseUrl: string;
  };
  asr: {
    provider: Extract<AiProviderId, 'none' | 'openai-compatible'>;
    model: string;
    apiKey: string;
    endpoint: string;
  };
  /** Use the vision provider to read on-screen text. */
  useProviderForOcr: boolean;
  /** Allow AI translation of dialogue that has no platform subtitle track. */
  allowTranslation: boolean;
}

export interface PrivacySettings {
  /** Persist raw captured audio. Off, and there is no UI path to bulk export. */
  retainRawAudio: boolean;
  /** Persist raw captured video frames. Off. */
  retainRawVideo: boolean;
  /** Keep saved screenplays after the browser restarts. */
  persistSavedScripts: boolean;
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  fontScale: number;
  reducedMotion: boolean;
}

export interface AdvancedSettings {
  /** Show the diagnostics panel in the side panel. */
  diagnosticsEnabled: boolean;
  /** Verbose console logging from the analysis pipeline. */
  verboseLogging: boolean;
}

export interface FrameScriptSettings {
  schemaVersion: number;
  playback: PlaybackSettings;
  analysis: AnalysisSettings;
  languages: LanguageSettings;
  screenplay: ScreenplaySettings;
  ai: AiSettings;
  privacy: PrivacySettings;
  appearance: AppearanceSettings;
  advanced: AdvancedSettings;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: FrameScriptSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  playback: {
    maximumQualityEnabled: true,
    youtubeQuality: 'best-available',
    preferEnhancedBitrate: true,
    respectManualOverride: true,
    netflixQualityGuard: true,
  },
  analysis: {
    fidelity: 'detailed',
    sources: { subtitles: true, audio: true, video: true, ocr: true, soundEvents: true },
    continueWhenHidden: true,
  },
  languages: {
    scriptLanguage: 'system',
    preferredSubtitleLanguage: 'platform-default',
    showOriginalDialogue: true,
    dualLanguageView: false,
    secondaryLanguage: 'en',
  },
  screenplay: {
    showTimestamps: true,
    followPlayback: true,
    autoScroll: true,
    defaultView: 'screenplay',
    includeLowConfidence: false,
  },
  ai: {
    remoteEnabled: false,
    consentAcknowledged: false,
    vision: { provider: 'none', model: 'claude-sonnet-5', apiKey: '', baseUrl: '' },
    asr: { provider: 'none', model: 'whisper-1', apiKey: '', endpoint: '' },
    useProviderForOcr: false,
    allowTranslation: false,
  },
  privacy: { retainRawAudio: false, retainRawVideo: false, persistSavedScripts: true },
  appearance: { theme: 'dark', fontScale: 1, reducedMotion: false },
  advanced: { diagnosticsEnabled: false, verboseLogging: false },
};

/** Deep-merges stored settings over defaults so new keys appear automatically. */
export function mergeSettings(
  stored: Partial<FrameScriptSettings> | undefined,
): FrameScriptSettings {
  if (!stored) return structuredCloneSettings(DEFAULT_SETTINGS);
  const base = structuredCloneSettings(DEFAULT_SETTINGS);
  return {
    ...base,
    ...stored,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    playback: { ...base.playback, ...stored.playback },
    analysis: {
      ...base.analysis,
      ...stored.analysis,
      sources: { ...base.analysis.sources, ...stored.analysis?.sources },
    },
    languages: { ...base.languages, ...stored.languages },
    screenplay: { ...base.screenplay, ...stored.screenplay },
    ai: {
      ...base.ai,
      ...stored.ai,
      vision: { ...base.ai.vision, ...stored.ai?.vision },
      asr: { ...base.ai.asr, ...stored.ai?.asr },
    },
    privacy: { ...base.privacy, ...stored.privacy },
    appearance: { ...base.appearance, ...stored.appearance },
    advanced: { ...base.advanced, ...stored.advanced },
  };
}

function structuredCloneSettings(settings: FrameScriptSettings): FrameScriptSettings {
  return JSON.parse(JSON.stringify(settings)) as FrameScriptSettings;
}

/**
 * Strips secrets for anything that crosses a boundary where they are not
 * needed — diagnostics, the side panel, exports.
 */
export function redactSettings(settings: FrameScriptSettings): FrameScriptSettings {
  const copy = structuredCloneSettings(settings);
  copy.ai.vision.apiKey = settings.ai.vision.apiKey ? '<set>' : '';
  copy.ai.asr.apiKey = settings.ai.asr.apiKey ? '<set>' : '';
  return copy;
}

/** Exactly what would leave the device with the current configuration. */
export function describeDataTransmission(settings: FrameScriptSettings): string[] {
  if (!settings.ai.remoteEnabled) {
    return ['Remote AI is off. No video, audio, subtitles, or viewing data leaves this device.'];
  }
  const items: string[] = [];
  if (settings.ai.vision.provider !== 'none') {
    items.push(
      'Selected keyframes (downscaled) from analyzed windows, plus the dialogue text and sound-event labels in those windows.',
    );
    if (settings.ai.useProviderForOcr) items.push('Keyframes containing on-screen text, for text reading.');
  }
  if (settings.ai.asr.provider !== 'none') {
    items.push('Short audio windows containing detected speech, downsampled to 16 kHz mono.');
  }
  if (settings.ai.allowTranslation) items.push('Dialogue and action text being translated.');
  if (items.length === 0) items.push('Remote AI is on, but no provider is configured, so nothing is sent.');
  items.push('Never sent: the full video, the full audio track, your account details, or your viewing history.');
  return items;
}
