/**
 * FrameScript core — the platform-independent engine.
 *
 * Everything exported here runs anywhere JavaScript runs: the Chrome
 * extension, the web app, the CLI, and the MCP server all import from this
 * barrel and share one implementation.
 *
 * Nothing in this module tree touches `chrome.*`, and the only DOM types used
 * are the standard ones a browser or a polyfill provides. That constraint is
 * what makes a second frontend cheap rather than a rewrite.
 */

// --- Evidence ------------------------------------------------------------------
export { EvidenceTimeline } from '../evidence/timeline';
export type { CoverageMap, TimelineOptions } from '../evidence/timeline';
export { buildEvidenceWindows, emptyWindow, windowIsEmpty } from '../evidence/windows';
export type { EvidenceWindow, WindowingOptions } from '../evidence/windows';
export * from '../evidence/types';
export {
  confidenceRank,
  corroborate,
  derive,
  describeConfidence,
  fromScore,
  maxConfidence,
  minConfidence,
} from '../evidence/confidence';
export {
  describeSources,
  emptyProvenance,
  isPurelyInferred,
  mergeProvenance,
  provenanceFrom,
} from '../evidence/provenance';

// --- Temporal ------------------------------------------------------------------
export {
  computeFrameSignature,
  isBlankFrame,
  signatureFromLuma,
  HISTOGRAM_BINS,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
} from '../temporal/FrameSignature';
export type { FrameSignature, SignatureInput } from '../temporal/FrameSignature';
export {
  computeTemporalMetrics,
  frameDifference,
  histogramDistance,
  motionScore,
  regionDifference,
  regionEdgeEnergy,
  sceneCutScore,
  FACE_REGION,
  SUBTITLE_REGION,
  TITLE_REGION,
} from '../temporal/FrameDifference';
export { TemporalScanner } from '../temporal/TemporalScanner';
export type {
  DeepAnalysisRequest,
  ObservationContext,
  ScannerStats,
  TemporalScannerCallbacks,
} from '../temporal/TemporalScanner';
export { AdaptiveSampler } from '../temporal/AdaptiveSampler';
export {
  ActionSegmenter,
  findHesitations,
  mergeAdjacentSegments,
} from '../temporal/ActionSegmenter';
export type { ActionSegment } from '../temporal/ActionSegmenter';
export { KeyframeBuffer, toFrameRef } from '../temporal/KeyframeBuffer';
export {
  EVENT_THRESHOLD,
  PROMOTION_THRESHOLD,
  isRedundant,
  scoreImportance,
} from '../temporal/ImportanceScorer';
export {
  DEFAULT_FIDELITY,
  FIDELITY_PROFILES,
  effectiveObservationFps,
  profileFor,
} from '../temporal/fidelity';
export type { AnalysisFidelity, FidelityProfile } from '../temporal/fidelity';

// --- Audio ---------------------------------------------------------------------
export {
  amplitudeToDb,
  computeMfcc,
  cosineDistance,
  encodeWav,
  magnitudeSpectrum,
  resampleLinear,
  rms,
  spectralCentroid,
  spectralFlatness,
  spectralFlux,
  zeroCrossingRate,
} from '../audio/dsp';
export { VoiceActivityDetector, detectSpeechRegions } from '../audio/vad';
export type { SpeechRegion, VadOptions } from '../audio/vad';
export { SpeakerDiarizer, looksOverlapped } from '../audio/diarization';
export type { DiarizationAssignment } from '../audio/diarization';
export { SoundEventDetector, classifyOnset, describeSoundEvent } from '../audio/soundEvents';
export type { SoundOnset } from '../audio/soundEvents';
export { describeSilence, findSilences } from '../audio/silence';
export type { SilenceGap } from '../audio/silence';

// --- Subtitles -----------------------------------------------------------------
export {
  SubtitleAccumulator,
  normalizeSubtitleText,
  rollUpOverlap,
  splitDashedLines,
} from '../capture/subtitle/normalize';
export type { NormalizedCue, RawSubtitleObservation } from '../capture/subtitle/normalize';
export {
  cuesToEvidence,
  detectSubtitleFormat,
  languageFromFilename,
  parseSubtitleFile,
  parseTimestamp,
} from '../capture/subtitle/parseSubtitleFile';
export type { ParsedCue, ParseSubtitleResult } from '../capture/subtitle/parseSubtitleFile';

// --- Characters ----------------------------------------------------------------
export { CharacterRegistry, characterCueName } from '../characters/entities';
export type { CharacterEntity, SceneCharacterPresence } from '../characters/entities';
export {
  attributeSpeaker,
  extractSpeakerLabel,
  isNonSpeechCaption,
} from '../characters/attribution';

// --- Scenes --------------------------------------------------------------------
export { SceneBuilder } from '../scenes/builder';
export { fuseWindow } from '../scenes/fusion';
export type { FusionConflict, FusionContext, FusionResult } from '../scenes/fusion';
export {
  collectBoundarySignals,
  detectSceneBoundaries,
  scoreBoundaryCandidates,
  selectBoundaries,
} from '../scenes/boundaries';
export * from '../scenes/types';

// --- Screenplay ----------------------------------------------------------------
export {
  SUPPORTED_SCRIPT_LANGUAGES,
  coverageNote,
  documentToText,
  formatSceneHeading,
  renderScreenplay,
} from '../screenplay/languageRenderer';
export type { RenderOptions } from '../screenplay/languageRenderer';
export { activeLineIndex, emptyDocument } from '../screenplay/types';
export type { ScreenplayDocument, ScreenplayLine, ScreenplayLineKind } from '../screenplay/types';
export { alignCueTracks, groupToDualText } from '../screenplay/alignment';
export type { AlignmentGroup, TimedText } from '../screenplay/alignment';
export { findMatch, searchScreenplay } from '../screenplay/search';
export type { SearchOptions, SearchResult, SearchScope } from '../screenplay/search';
export {
  RECONSTRUCTION_NOTICE,
  buildFilename,
  exportScreenplay,
  toJson,
  toMarkdown,
  toSrt,
} from '../screenplay/export';
export type { ExportFormat, ExportOptions, ExportResult } from '../screenplay/export';
export { toFountain } from '../screenplay/export/fountain';
export type { ExportMetadata, FountainOptions } from '../screenplay/export/fountain';

// --- Quality (parsing and ranking only; drivers are platform-specific) ---------
export { parseQualityOption, parseQualityOptions, parseResolution } from '../quality/parser';
export {
  compareQuality,
  describeQuality,
  rankQualityOptions,
  selectQualityOption,
} from '../quality/ranking';
export * from '../quality/types';

// --- Storage schema ------------------------------------------------------------
export { SCREENPLAY_SCHEMA_VERSION, screenplayId, summarize } from '../storage/schema';
export type { CoverageRecord, ScreenplaySummary, StoredScreenplay } from '../storage/schema';
export { migrateScreenplay } from '../storage/migrations';
export {
  FRAMESCRIPT_PROJECT_FORMAT,
  FRAMESCRIPT_PROJECT_VERSION,
  parseFrameScriptProject,
} from '../storage/projectFormat';
export type {
  FrameScriptProject,
  ProjectCoverage,
  ProjectParseResult,
  ProjectSourceSummary,
} from '../storage/projectFormat';

// --- Utilities -----------------------------------------------------------------
export { createIdFactory, hash32, shortHash } from '../utils/id';
export {
  clamp,
  coveredDuration,
  formatSrtTimestamp,
  formatTimecode,
  invertRanges,
  mergeRanges,
  msToSeconds,
  overlapDuration,
  rangesOverlap,
  secondsToMs,
  temporalIou,
} from '../utils/time';
export type { MediaTimeMs, TimeRange } from '../utils/time';
export {
  collapseWhitespace,
  comparableText,
  containsCjk,
  slugify,
  textSimilarity,
} from '../utils/text';
export { FrameScriptError, describeError, errorDetail, userMessageFor } from '../utils/errors';
export type { FrameScriptErrorCode } from '../utils/errors';

// --- Pipeline ------------------------------------------------------------------
export { buildScreenplay, collectLanguages, summarizeBeats } from './pipeline';
export type { BuildOptions, BuildResult } from './pipeline';
