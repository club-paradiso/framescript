/**
 * Cross-context message protocol.
 *
 * MV3 splits FrameScript across five isolated realms — service worker, content
 * script, offscreen document, side panel, popup/options. Every message between
 * them is declared here as a discriminated union so the compiler catches a
 * mismatch instead of a listener silently ignoring an unknown shape.
 *
 * Messages are validated at the receiving end as well (see `validation.ts`),
 * because a content script runs in a page the extension does not control.
 */

import type { AnalysisFidelity } from '../temporal/fidelity';
import type { EvidenceEvent, EvidenceSourceStatus, SourceStateMap } from '../evidence/types';
import type { QualityApplyResult, QualityCapabilities, QualityState, NetflixQualityReport } from '../quality/types';
import type { CharacterEntity } from '../characters/entities';
import type { ReconstructedScene } from '../scenes/types';
import type { FrameScriptSettings } from '../settings/types';
import type { MediaTimeMs, TimeRange } from '../utils/time';
import type { ExportFormat } from '../screenplay/export';
import type { ScreenplaySummary } from '../storage/schema';

export type PlatformId = 'youtube' | 'netflix';

export interface ContentIdentity {
  platform: PlatformId;
  contentId: string;
  title?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
  durationMs?: number;
  url: string;
}

export interface PlayerState {
  playing: boolean;
  currentTimeMs: MediaTimeMs;
  durationMs?: MediaTimeMs;
  playbackRate: number;
  videoWidth?: number;
  videoHeight?: number;
  /** True when the media element reports a protected (encrypted) pipeline. */
  protectedPlayback?: boolean;
}

export interface SubtitleLanguage {
  id: string;
  code?: string;
  label: string;
  source: 'platform' | 'auto-generated' | 'unknown';
  isActive: boolean;
}

export type AnalysisPhase = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'error';

export interface AnalysisStatus {
  phase: AnalysisPhase;
  tabId?: number;
  fidelity: AnalysisFidelity;
  sources: SourceStateMap;
  /** Measured, not configured. */
  observedFps?: number;
  deepAnalysisPerMinute?: number;
  coverageRatio?: number;
  uncovered?: TimeRange[];
  errorMessage?: string;
}

export interface QualityStatus {
  state: QualityState;
  platform: PlatformId;
  capabilities?: QualityCapabilities;
  result?: QualityApplyResult;
  netflix?: NetflixQualityReport;
  /** True when the viewer changed quality by hand on this video. */
  userOverridden: boolean;
}

export interface SessionSnapshot {
  identity?: ContentIdentity;
  player?: PlayerState;
  quality?: QualityStatus;
  analysis: AnalysisStatus;
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  subtitleLanguages: SubtitleLanguage[];
  /** Languages for which any dialogue evidence exists. */
  availableLanguages: string[];
}

// --- Messages -----------------------------------------------------------------

interface Envelope<T extends string, P = undefined> {
  type: T;
  payload: P;
}

/** Sent by the content script to the service worker. */
export type ContentToWorker =
  | Envelope<'content/ready', { platform: PlatformId; url: string }>
  | Envelope<'content/identity', ContentIdentity | null>
  | Envelope<'content/player-state', PlayerState>
  | Envelope<'content/evidence', { events: EvidenceEvent[] }>
  | Envelope<'content/quality', QualityStatus>
  | Envelope<'content/subtitle-languages', { languages: SubtitleLanguage[] }>
  | Envelope<'content/navigated', { url: string }>
  | Envelope<'content/error', { code: string; message: string }>;

/** Sent by the service worker to a content script. */
export type WorkerToContent =
  | Envelope<'worker/apply-quality', { preference: string; preferEnhancedBitrate: boolean }>
  | Envelope<'worker/start-subtitles', { language?: string }>
  | Envelope<'worker/stop-subtitles'>
  | Envelope<'worker/request-state'>
  | Envelope<'worker/seek', { toMs: MediaTimeMs }>
  | Envelope<'worker/set-subtitle-language', { languageId: string }>
  | Envelope<'worker/settings-changed', { settings: FrameScriptSettings }>;

/** Sent by UI surfaces to the service worker. */
export type UiToWorker =
  | Envelope<'ui/get-snapshot', { tabId?: number }>
  | Envelope<'ui/start-analysis', { tabId: number; streamId?: string }>
  | Envelope<'ui/stop-analysis', { tabId: number }>
  | Envelope<'ui/pause-analysis', { tabId: number }>
  | Envelope<'ui/resume-analysis', { tabId: number }>
  | Envelope<'ui/seek', { tabId: number; toMs: MediaTimeMs }>
  | Envelope<'ui/assign-speaker', { tabId: number; beatId: string; characterId: string; scope: 'single' | 'forward' }>
  | Envelope<'ui/rename-character', { tabId: number; characterId: string; name: string }>
  | Envelope<'ui/merge-characters', { tabId: number; targetId: string; sourceId: string }>
  | Envelope<'ui/split-speaker', { tabId: number; characterId: string; speakerId: string }>
  | Envelope<'ui/set-setting', { tabId: number; sceneId: string; description: string }>
  | Envelope<'ui/export', { tabId: number; format: ExportFormat; language: string; options: Record<string, boolean> }>
  | Envelope<'ui/save-screenplay', { tabId: number }>
  | Envelope<'ui/list-saved', undefined>
  | Envelope<'ui/delete-saved', { id: string }>
  | Envelope<'ui/set-subtitle-language', { tabId: number; languageId: string }>
  | Envelope<'ui/open-side-panel', { tabId: number }>;

/** Broadcast by the service worker to any listening UI surface. */
export type WorkerToUi =
  | Envelope<'worker/snapshot', SessionSnapshot>
  | Envelope<'worker/analysis-status', AnalysisStatus>
  | Envelope<'worker/scenes-updated', { scenes: ReconstructedScene[]; characters: CharacterEntity[] }>
  | Envelope<'worker/quality-status', QualityStatus>
  | Envelope<'worker/player-state', PlayerState>
  | Envelope<'worker/saved-list', { items: ScreenplaySummary[] }>
  | Envelope<'worker/export-ready', { filename: string; mimeType: string; content: string }>
  | Envelope<'worker/notice', { code: string; message: string; severity: 'info' | 'warning' | 'error' }>;

/** Service worker <-> offscreen media document. */
export type WorkerToOffscreen =
  | Envelope<
      'offscreen/start',
      { streamId: string; tabId: number; fidelity: AnalysisFidelity; sources: Record<string, boolean> }
    >
  | Envelope<'offscreen/stop'>
  | Envelope<'offscreen/pause'>
  | Envelope<'offscreen/resume'>
  | Envelope<'offscreen/media-time', { currentTimeMs: MediaTimeMs; playing: boolean }>
  | Envelope<'offscreen/configure', { fidelity: AnalysisFidelity; sources: Record<string, boolean> }>;

export type OffscreenToWorker =
  | Envelope<'offscreen/ready'>
  | Envelope<'offscreen/evidence', { events: EvidenceEvent[] }>
  | Envelope<'offscreen/source-status', { statuses: EvidenceSourceStatus[] }>
  | Envelope<'offscreen/stats', { observedFps: number; deepRequests: number; queueLength: number; droppedFrames: number }>
  | Envelope<'offscreen/error', { code: string; message: string }>;

export type FrameScriptMessage =
  | ContentToWorker
  | WorkerToContent
  | UiToWorker
  | WorkerToUi
  | WorkerToOffscreen
  | OffscreenToWorker;

export type MessageType = FrameScriptMessage['type'];

export function isFrameScriptMessage(value: unknown): value is FrameScriptMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.includes('/')
  );
}
