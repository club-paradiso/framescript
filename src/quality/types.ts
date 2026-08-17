/**
 * Playback quality data model.
 *
 * The single most important rule in this module: FrameScript selects the best
 * quality the platform *currently offers*. It never fabricates, unlocks, or
 * requests a representation the player did not present as selectable.
 */

export interface VideoQualityOption {
  /** Stable identity for the option within the current menu reading. */
  id: string;
  /** The label exactly as the player rendered it, in the player's own locale. */
  label: string;
  /** Vertical resolution in pixels, when it could be parsed from the label. */
  resolution?: number;
  /** YouTube's "Premium"/enhanced-bitrate variant of an otherwise equal tier. */
  enhancedBitrate: boolean;
  hdr?: boolean;
  frameRate?: number;
  /** False for options the player renders but refuses (entitlement, codec, …). */
  selectable: boolean;
  /** True when the player marks this entry as the currently active quality. */
  active?: boolean;
  /** True for the player's own adaptive/"Auto" entry, which is not a fixed tier. */
  auto?: boolean;
}

export type QualityPreferenceId =
  | 'best-available'
  | 'max-2160'
  | 'max-1440'
  | 'max-1080'
  | 'max-720'
  | 'platform-auto';

export interface QualityPreference {
  id: QualityPreferenceId;
  /** Ceiling in vertical pixels; undefined means "no ceiling". */
  maxResolution?: number;
  /** Prefer the enhanced-bitrate variant when the user is entitled to it. */
  preferEnhancedBitrate: boolean;
}

export const QUALITY_PREFERENCES: Record<QualityPreferenceId, Omit<QualityPreference, 'preferEnhancedBitrate'>> =
  {
    'best-available': { id: 'best-available' },
    'max-2160': { id: 'max-2160', maxResolution: 2160 },
    'max-1440': { id: 'max-1440', maxResolution: 1440 },
    'max-1080': { id: 'max-1080', maxResolution: 1080 },
    'max-720': { id: 'max-720', maxResolution: 720 },
    'platform-auto': { id: 'platform-auto' },
  };

export const QUALITY_PREFERENCE_LABELS: Record<QualityPreferenceId, string> = {
  'best-available': 'Best available',
  'max-2160': 'Prefer 2160p or lower',
  'max-1440': 'Prefer 1440p or lower',
  'max-1080': 'Prefer 1080p or lower',
  'max-720': 'Prefer 720p or lower',
  'platform-auto': 'Platform default (FrameScript disabled)',
};

/**
 * Quality controller states. `platform-limited` and `user-overridden` are not
 * failures — they are correct, honest outcomes we surface as such.
 */
export type QualityState =
  | 'idle'
  | 'detecting'
  | 'waiting-for-player'
  | 'reading-options'
  | 'applying'
  | 'best-available'
  | 'user-overridden'
  | 'platform-limited'
  | 'unsupported'
  | 'error';

export interface QualityCapabilities {
  /** Options as read from the player, in the order the player listed them. */
  options: VideoQualityOption[];
  /** The option the player reports as active, if it could be determined. */
  activeOptionId?: string;
  /** True when the player is currently in its own adaptive mode. */
  platformAuto: boolean;
  /** True when the menu was readable at all; false means the DOM has changed. */
  menuReadable: boolean;
}

export interface QualityApplyResult {
  state: QualityState;
  /** The option FrameScript asked the player to use. */
  requested?: VideoQualityOption;
  /** What the player reported afterwards, when verification was possible. */
  applied?: VideoQualityOption;
  /** True when `applied` was confirmed by re-reading the player. */
  verified: boolean;
  /** Present when the best available option was below the user's preference. */
  limitedBy?: 'availability' | 'preference' | 'entitlement' | 'unknown';
  message?: string;
}

/**
 * Environment facts we can read without touching anything protected. This is a
 * *capability ceiling*, never a claim about the stream actually being served.
 */
export interface PlaybackEnvironment {
  os: 'windows' | 'macos' | 'chromeos' | 'linux' | 'android' | 'ios' | 'unknown';
  browser: 'chrome' | 'other';
  browserVersion?: number;
  displayWidth?: number;
  displayHeight?: number;
  devicePixelRatio?: number;
  hardwareConcurrency?: number;
}

/**
 * Netflix quality states. Netflix's delivered representation is decided
 * server-side inside a protected pipeline; FrameScript reports what it can
 * observe and says "unknown" where it cannot.
 */
export type NetflixQualityState =
  | 'optimizing'
  | 'best-effort-active'
  | 'platform-limited'
  | 'account-setting-may-limit'
  | 'actual-resolution-unknown'
  | 'unsupported'
  | 'error';

export interface NetflixQualityReport {
  state: NetflixQualityState;
  environment: PlaybackEnvironment;
  /** Highest resolution this environment could plausibly support, if known. */
  environmentCeiling?: number;
  /**
   * Resolution of the video element's decoded frames, when the element exposes
   * it. On protected playback this is frequently unavailable — that is not an
   * error and must never be replaced with a guess.
   */
  observedVideoHeight?: number;
  /** Human-readable notes, each individually true and individually optional. */
  notes: string[];
}
