/**
 * AI provider abstractions.
 *
 * FrameScript is not wired to any single vendor. Each capability is an
 * interface with at least one local implementation, so the product degrades to
 * "local only, no network" cleanly rather than breaking.
 *
 * Remote inference is off by default and requires the user's own key.
 */

import type { MediaTimeMs } from '../utils/time';
import type { ConfidenceLevel, SoundEventKind, TemporalMetrics } from '../evidence/types';

export type ProviderKind = 'local' | 'remote';

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Exactly what leaves the device when this provider runs. Shown in settings. */
  dataLeavingDevice: string;
}

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface BaseProvider {
  readonly info: ProviderInfo;
  isAvailable(): Promise<ProviderAvailability>;
}

// --- Speech recognition -------------------------------------------------------

export interface AsrRequest {
  /** Mono PCM for one speech region. */
  samples: Float32Array;
  sampleRate: number;
  start: MediaTimeMs;
  end: MediaTimeMs;
  /** Hint only; providers may detect a different language. */
  languageHint?: string;
  signal?: AbortSignal;
}

export interface AsrResult {
  text: string;
  language?: string;
  /** Only set when the provider supplies a calibrated score. */
  providerScore?: number;
}

export interface SpeechRecognitionProvider extends BaseProvider {
  transcribe(request: AsrRequest): Promise<AsrResult | null>;
}

// --- Vision -------------------------------------------------------------------

export interface VisionFrame {
  timestamp: MediaTimeMs;
  /** Encoded image bytes. */
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * A vision request is always a *window*, never a lone still.
 *
 * Frames arrive in temporal order with their timestamps, alongside the dialogue
 * and sound that occurred in the same span, so the provider can describe how an
 * action progressed rather than captioning a photograph.
 */
export interface VisionWindowRequest {
  start: MediaTimeMs;
  end: MediaTimeMs;
  frames: VisionFrame[];
  /** Metrics from the local scanner, so the model knows where the change was. */
  metrics?: TemporalMetrics;
  dialogue: { start: MediaTimeMs; speakerId?: string; text: string }[];
  soundEvents: { start: MediaTimeMs; kind: SoundEventKind; description?: string }[];
  /** Characters believed present when the window opened. */
  knownCharacters: { id: string; displayName?: string }[];
  /** Setting established by the current scene, if any. */
  currentSetting?: string;
  /** Ask the provider to read on-screen text in this window. */
  requestOcr?: boolean;
  signal?: AbortSignal;
}

export interface StructuredAction {
  /** ms offset from the window start; keeps ordering explicit. */
  offsetMs: number;
  description: string;
  participants: string[];
  confidence: ConfidenceLevel;
}

export interface CharacterObservation {
  /** Provider-local label, e.g. "man in blue coat". Never an actor's name. */
  label: string;
  present: boolean;
  enters?: boolean;
  exits?: boolean;
  /** Broad expression change only, e.g. "stiffens", "smiles". */
  expression?: string;
}

export interface SettingObservation {
  description: string;
  interiorExterior?: 'INT' | 'EXT' | 'UNKNOWN';
  timeOfDay?: string;
  confidence: ConfidenceLevel;
}

export interface OnScreenTextObservation {
  text: string;
  offsetMs: number;
}

export interface VisionWindowAnalysis {
  actions: StructuredAction[];
  characters: CharacterObservation[];
  settingChanges: SettingObservation[];
  text: OnScreenTextObservation[];
  /** Things the provider explicitly could not determine. Surfaced, not hidden. */
  uncertainties: string[];
}

export interface VisionAnalysisProvider extends BaseProvider {
  analyzeWindow(request: VisionWindowRequest): Promise<VisionWindowAnalysis | null>;
}

// --- OCR ----------------------------------------------------------------------

export interface OcrRequest {
  frame: VisionFrame;
  signal?: AbortSignal;
}

export interface OcrLine {
  text: string;
  region?: { x: number; y: number; width: number; height: number };
}

export interface OcrProvider extends BaseProvider {
  recognize(request: OcrRequest): Promise<OcrLine[]>;
}

// --- Sound events -------------------------------------------------------------

export interface SoundEventRequest {
  samples: Float32Array;
  sampleRate: number;
  start: MediaTimeMs;
  end: MediaTimeMs;
  signal?: AbortSignal;
}

export interface SoundEventResult {
  kind: SoundEventKind;
  description?: string;
  confidence: ConfidenceLevel;
}

export interface SoundEventProvider extends BaseProvider {
  classify(request: SoundEventRequest): Promise<SoundEventResult | null>;
}

// --- Translation --------------------------------------------------------------

export interface TranslationRequest {
  texts: string[];
  sourceLanguage?: string;
  targetLanguage: string;
  /** Surrounding scene description, to keep pronouns and register consistent. */
  context?: string;
  signal?: AbortSignal;
}

export interface TranslationProvider extends BaseProvider {
  translate(request: TranslationRequest): Promise<string[] | null>;
}

// --- Screenplay language rendering --------------------------------------------

export interface ScreenplayRenderRequest {
  /** Structured beats to phrase; the model rewrites wording, never facts. */
  beats: { kind: 'action' | 'sound' | 'transition'; text: string; offsetMs: number }[];
  targetLanguage: string;
  sceneHeading?: string;
  signal?: AbortSignal;
}

export interface ScreenplayLanguageProvider extends BaseProvider {
  render(request: ScreenplayRenderRequest): Promise<string[] | null>;
}

// --- Fusion -------------------------------------------------------------------

export interface FusionRequest {
  windowStart: MediaTimeMs;
  windowEnd: MediaTimeMs;
  subtitles: { start: MediaTimeMs; text: string; speakerLabel?: string }[];
  speech: { start: MediaTimeMs; text: string; speakerId?: string }[];
  visualActions: StructuredAction[];
  sounds: { start: MediaTimeMs; kind: SoundEventKind }[];
  signal?: AbortSignal;
}

export interface FusionDecision {
  /** Which dialogue lines survived fusion, in order. */
  dialogue: { start: MediaTimeMs; speakerId?: string; text: string; confidence: ConfidenceLevel }[];
  /** Conflicts the fuser could not resolve; preserved as uncertainty. */
  conflicts: string[];
}

export interface MultimodalFusionProvider extends BaseProvider {
  fuse(request: FusionRequest): Promise<FusionDecision | null>;
}

// --- Registry -----------------------------------------------------------------

export interface ProviderRegistry {
  asr?: SpeechRecognitionProvider;
  vision?: VisionAnalysisProvider;
  ocr?: OcrProvider;
  soundEvents?: SoundEventProvider;
  translation?: TranslationProvider;
  screenplayLanguage?: ScreenplayLanguageProvider;
  fusion?: MultimodalFusionProvider;
}
