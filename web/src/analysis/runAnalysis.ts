/**
 * The Studio analysis run.
 *
 * One pass over one local file, in named phases, producing evidence for the
 * deterministic reconstruction engine. The order matters and is deliberate:
 *
 *   read → decode audio → detect speech → identify speakers → transcribe
 *        → scan picture → analyze selected scenes → build
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Partial success survives.** Every stage is allowed to fail on its own.
 *     Transcription failing does not lose the speaker clusters; the picture
 *     scan failing does not lose the transcript; a vision failure loses only
 *     the semantic descriptions. Each failure becomes a notice with a code,
 *     never an exception that discards the run.
 *
 *  2. **Nothing unbounded reaches the network.** Speech is planned into bounded
 *     windows, encoded one at a time inside a concurrency-limited queue, and
 *     released immediately. Keyframes are captured only inside windows the
 *     local scanner opened, and are capped for the whole file.
 *
 *  3. **Coverage is reported per source.** "The timeline was observed" and
 *     "the speech was transcribed" are different numbers and are kept apart.
 */

import {
  FrameScriptError,
  describeError,
  encodeAsrWindow,
  errorDetail,
  isAbort,
  planSpeechWindows,
  secondsToMs,
  sliceWindow,
  transcriptToEvidence,
  visionAnalysisToEvidence,
  type AnalysisFidelity,
  type EvidenceEvent,
  type FrameScriptErrorCode,
  type SoundEvidence,
  type SpeakerEvidence,
  type SpeechEvidence,
  type SpeechRegion,
} from '@/core';
import {
  analyzeAudioBuffer,
  decodeAudioTrack,
  loadMediaMetadata,
  probeAudioTrack,
  scanVideoDuringPlayback,
  type KeyframeWindow,
} from './localMediaAnalyzer';
import { analyzeFrames, runBounded, transcribeWindow, type Capabilities } from './apiClient';

export type PhaseId =
  | 'reading'
  | 'decoding'
  | 'speech'
  | 'speakers'
  | 'transcribing'
  | 'scanning'
  | 'scenes'
  | 'building'
  | 'done';

export interface AnalysisProgress {
  phase: PhaseId;
  label: string;
  /** 0..1 when genuinely measurable. Left undefined rather than invented. */
  ratio?: number;
  detail?: string;
}

export const PHASE_LABELS: Record<PhaseId, string> = {
  reading: 'Reading media',
  decoding: 'Decoding audio',
  speech: 'Detecting speech',
  speakers: 'Identifying speakers',
  transcribing: 'Transcribing speech',
  scanning: 'Scanning picture',
  scenes: 'Analyzing selected scenes',
  building: 'Building screenplay',
  done: 'Done',
};

export interface AnalysisNotice {
  code: FrameScriptErrorCode;
  message: string;
  /** Developer-facing. Shown in diagnostics, never presented as the message. */
  detail?: string;
}

export interface RequestTally {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface AnalysisStats {
  speechRegions: number;
  speakers: number;
  soundEvents: number;
  silences: number;
  observations: number;
  sceneCuts: number;
  actionSegments: number;
  speechWindowsPlanned: number;
  speechWindowsTranscribed: number;
  dialogueSegments: number;
  keyframeWindows: number;
  keyframesCaptured: number;
  keyframeBytes: number;
  sceneObservations: number;
}

export interface AnalysisCoverage {
  audioDecoded: boolean;
  /** Highest media time the picture scan actually reached. */
  videoObservedMs: number;
  durationMs: number;
  /** Detected speech that came back with text, as a ratio of planned windows. */
  transcribedRatio?: number;
}

export interface AnalysisOutcome {
  events: EvidenceEvent[];
  durationMs: number;
  stats: AnalysisStats;
  coverage: AnalysisCoverage;
  notices: AnalysisNotice[];
  requests: { asr: RequestTally; vision: RequestTally };
  aborted: boolean;
  /** The phase the run was in when it stopped, for diagnostics. */
  lastPhase: PhaseId;
}

export interface RunAnalysisOptions {
  file: File;
  /** Present for video files; audio-only files pass null. */
  video: HTMLVideoElement | null;
  fidelity: AnalysisFidelity;
  scanRate: number;
  analyzeAudio: boolean;
  analyzeVideo: boolean;
  /** Only honoured when capabilities report transcription as configured. */
  transcribe: boolean;
  sceneUnderstanding: boolean;
  /** Hard ceiling on vision requests for this file. */
  maxSceneWindows: number;
  languageHint?: string;
  capabilities: Capabilities;
  onProgress: (progress: AnalysisProgress) => void;
  signal: AbortSignal;
}

/** Concurrency caps. Deliberately small: this runs beside video playback. */
const ASR_CONCURRENCY = 2;
const VISION_CONCURRENCY = 2;
/** Consecutive provider failures after which a stage stops trying. */
const FAILURE_THRESHOLD = 3;

export async function runAnalysis(options: RunAnalysisOptions): Promise<AnalysisOutcome> {
  const events: EvidenceEvent[] = [];
  const notices: AnalysisNotice[] = [];
  const asrRequests: RequestTally = { attempted: 0, succeeded: 0, failed: 0 };
  const visionRequests: RequestTally = { attempted: 0, succeeded: 0, failed: 0 };
  const stats: AnalysisStats = {
    speechRegions: 0,
    speakers: 0,
    soundEvents: 0,
    silences: 0,
    observations: 0,
    sceneCuts: 0,
    actionSegments: 0,
    speechWindowsPlanned: 0,
    speechWindowsTranscribed: 0,
    dialogueSegments: 0,
    keyframeWindows: 0,
    keyframesCaptured: 0,
    keyframeBytes: 0,
    sceneObservations: 0,
  };

  let durationMs = 0;
  let audioDecoded = false;
  let videoObservedMs = 0;
  let lastPhase: PhaseId = 'reading';

  const note = (code: FrameScriptErrorCode, detail?: string) => {
    if (notices.some((notice) => notice.code === code)) return;
    notices.push({
      code,
      message: describeError(new FrameScriptError({ code })).message,
      ...(detail ? { detail } : {}),
    });
  };
  const report = (phase: PhaseId, ratio?: number, detail?: string) => {
    lastPhase = phase;
    options.onProgress({
      phase,
      label: PHASE_LABELS[phase],
      ...(ratio === undefined ? {} : { ratio }),
      ...(detail ? { detail } : {}),
    });
  };
  const aborted = () => options.signal.aborted;

  // --- Reading -----------------------------------------------------------------
  report('reading', undefined, options.file.name);
  let hasAudioTrack: boolean | undefined;
  if (options.video) {
    try {
      await loadMediaMetadata(options.video);
      durationMs = Math.max(durationMs, secondsToMs(options.video.duration || 0));
      hasAudioTrack = probeAudioTrack(options.video);
    } catch (error) {
      const code = FrameScriptError.is(error) ? error.code : 'VIDEO_METADATA_FAILED';
      note(code, errorDetail(error));
    }
  }

  // --- Audio -------------------------------------------------------------------
  let speakers: SpeakerEvidence[] = [];
  let mono: Float32Array | null = null;
  let sampleRate = 0;
  let regions: SpeechRegion[] = [];

  if (options.analyzeAudio && !aborted()) {
    report('decoding');
    const decoded = await decodeAudioTrack(options.file, {
      signal: options.signal,
      hasAudioTrack,
    });
    if (!decoded.ok) {
      if (decoded.code !== 'ANALYSIS_ABORTED') note(decoded.code, decoded.detail);
    } else if (!aborted()) {
      audioDecoded = true;
      durationMs = Math.max(durationMs, secondsToMs(decoded.buffer.duration));

      report('speech', 0);
      const audio = await analyzeAudioBuffer(decoded.buffer, (ratio) => {
        // The detectors run speech → speakers → sound → silence in one pass, so
        // the phase label follows the same measured ratio.
        report(ratio < 0.5 ? 'speech' : 'speakers', ratio);
      });
      events.push(...audio.events);
      speakers = audio.speakers;
      mono = audio.mono;
      sampleRate = audio.sampleRate;
      regions = audio.regions;
      stats.speechRegions = audio.stats.speechRegions;
      stats.speakers = audio.stats.speakers;
      stats.soundEvents = audio.stats.soundEvents;
      stats.silences = audio.stats.silences;
    }
  }

  // --- Transcription -----------------------------------------------------------
  const canTranscribe =
    options.transcribe && options.capabilities.transcription.configured && regions.length > 0;

  if (regions.length > 0 && options.transcribe && !options.capabilities.transcription.configured) {
    note('ASR_NOT_CONFIGURED', options.capabilities.transcription.reason);
  }

  if (canTranscribe && mono && !aborted()) {
    const plan = planSpeechWindows(regions, {
      maxWindowMs: Math.min(options.capabilities.limits.maxWindowMs, 28_000),
      durationMs: durationMs || undefined,
    });
    stats.speechWindowsPlanned = plan.windows.length;
    report('transcribing', 0, `0 of ${plan.windows.length} windows`);

    let consecutiveFailures = 0;
    let stopStage = false;
    let completed = 0;

    await runBounded(
      plan.windows,
      ASR_CONCURRENCY,
      async (window) => {
        if (stopStage || aborted()) return;
        // Encode inside the worker: preparing every WAV up front would hold the
        // whole film's speech in memory at once.
        const samples = sliceWindow(mono!, sampleRate, window);
        const wav = encodeAsrWindow(samples, sampleRate);
        if (!wav) return;

        asrRequests.attempted++;
        try {
          const result = await transcribeWindow({
            wav,
            start: window.start,
            end: window.end,
            ...(options.languageHint ? { languageHint: options.languageHint } : {}),
            signal: options.signal,
          });
          consecutiveFailures = 0;
          asrRequests.succeeded++;
          if (result) {
            const speechEvents = transcriptToEvidence(window, result, { speakers });
            events.push(...speechEvents);
            if (speechEvents.length > 0) stats.speechWindowsTranscribed++;
            stats.dialogueSegments += speechEvents.length;
          }
        } catch (error) {
          if (isAbort(error)) {
            stopStage = true;
            return;
          }
          asrRequests.failed++;
          consecutiveFailures++;
          const code = FrameScriptError.is(error) ? error.code : 'ASR_PROVIDER_FAILED';
          note(code, errorDetail(error));
          // Not configured, or refusing us outright: every remaining window
          // would fail the same way, so stop rather than make 200 doomed calls.
          if (code === 'ASR_NOT_CONFIGURED' || consecutiveFailures >= FAILURE_THRESHOLD) {
            stopStage = true;
          }
        } finally {
          completed++;
          report(
            'transcribing',
            plan.windows.length > 0 ? completed / plan.windows.length : undefined,
            `${stats.speechWindowsTranscribed} of ${plan.windows.length} windows transcribed`,
          );
        }
      },
      options.signal,
    );
  }

  // The waveform has served its purpose. Dropping it here rather than at the end
  // of the run means the picture scan does not run alongside a retained copy of
  // the whole decoded film.
  mono = null;

  // --- Picture -----------------------------------------------------------------
  let keyframeWindows: KeyframeWindow[] = [];
  if (options.analyzeVideo && options.video && !aborted()) {
    report('scanning', 0, `${options.scanRate}× scan`);
    const wantsKeyframes =
      options.sceneUnderstanding && options.capabilities.vision.configured
        ? options.maxSceneWindows
        : 0;

    const scan = await scanVideoDuringPlayback(options.video, {
      fidelity: options.fidelity,
      scanRate: options.scanRate,
      maxKeyframeWindows: wantsKeyframes,
      signal: options.signal,
      onProgress: (ratio) => report('scanning', ratio, `${options.scanRate}× scan`),
    });
    events.push(...scan.events);
    videoObservedMs = scan.observedMs;
    keyframeWindows = scan.keyframeWindows;
    stats.observations = scan.stats.observations;
    stats.sceneCuts = scan.stats.sceneCuts;
    stats.actionSegments = scan.stats.actionSegments;
    stats.keyframesCaptured = scan.stats.keyframesCaptured;
    stats.keyframeBytes = scan.stats.keyframeBytes;
    if (scan.failure) note(scan.failure.code, scan.failure.detail);
  }

  if (
    options.sceneUnderstanding &&
    !options.capabilities.vision.configured &&
    options.analyzeVideo &&
    options.video
  ) {
    note('VISION_NOT_CONFIGURED', options.capabilities.vision.reason);
  }

  // --- Scene understanding -----------------------------------------------------
  if (keyframeWindows.length > 0 && !aborted()) {
    // Most significant windows first, so a tight budget spends itself on the
    // parts of the film the local scanner already judged most eventful.
    const selected = [...keyframeWindows]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, options.maxSceneWindows)
      .sort((a, b) => a.start - b.start);
    stats.keyframeWindows = selected.length;

    let completed = 0;
    let consecutiveFailures = 0;
    let stopStage = false;
    report('scenes', 0, `0 of ${selected.length} scenes`);

    await runBounded(
      selected,
      VISION_CONCURRENCY,
      async (window) => {
        if (stopStage || aborted()) return;
        visionRequests.attempted++;
        try {
          const analysis = await analyzeFrames({
            start: window.start,
            end: window.end,
            frames: window.frames,
            dialogue: dialogueIn(events, window.start, window.end),
            soundEvents: soundsIn(events, window.start, window.end),
            signal: options.signal,
          });
          consecutiveFailures = 0;
          visionRequests.succeeded++;
          if (analysis) {
            const visionEvents = visionAnalysisToEvidence(
              analysis,
              { start: window.start, end: window.end },
              { importance: window.importance },
            );
            events.push(...visionEvents);
            stats.sceneObservations += visionEvents.length;
          }
        } catch (error) {
          if (isAbort(error)) {
            stopStage = true;
            return;
          }
          visionRequests.failed++;
          consecutiveFailures++;
          const code = FrameScriptError.is(error) ? error.code : 'VISION_PROVIDER_FAILED';
          note(code, errorDetail(error));
          if (code === 'VISION_NOT_CONFIGURED' || consecutiveFailures >= FAILURE_THRESHOLD) {
            stopStage = true;
          }
        } finally {
          completed++;
          // Frames are released as soon as their window has been sent, so the
          // page never holds the whole selection at once for long.
          window.frames.length = 0;
          report(
            'scenes',
            selected.length > 0 ? completed / selected.length : undefined,
            `${completed} of ${selected.length} scenes`,
          );
        }
      },
      options.signal,
    );
  }
  for (const window of keyframeWindows) window.frames.length = 0;

  report('building');
  if (aborted()) note('ANALYSIS_ABORTED');
  report('done');

  return {
    events,
    durationMs,
    stats,
    coverage: {
      audioDecoded,
      videoObservedMs,
      durationMs,
      ...(stats.speechWindowsPlanned > 0
        ? { transcribedRatio: stats.speechWindowsTranscribed / stats.speechWindowsPlanned }
        : {}),
    },
    notices,
    requests: { asr: asrRequests, vision: visionRequests },
    aborted: options.signal.aborted,
    lastPhase,
  };
}

function dialogueIn(events: readonly EvidenceEvent[], start: number, end: number) {
  return events
    .filter((event): event is SpeechEvidence => event.source === 'audio-asr')
    .filter((event) => event.start < end && (event.end ?? event.start) > start)
    .slice(0, 12)
    .map((event) => ({
      start: event.start,
      ...(event.payload.speakerId ? { speakerId: event.payload.speakerId } : {}),
      text: event.payload.text,
    }));
}

function soundsIn(events: readonly EvidenceEvent[], start: number, end: number) {
  return events
    .filter((event): event is SoundEvidence => event.source === 'audio-event')
    .filter((event) => event.start < end && (event.end ?? event.start) > start)
    .slice(0, 12)
    .map((event) => ({ start: event.start, kind: event.payload.kind }));
}

/** One-line summary for the source list. Uses measured values only. */
export function summarizeOutcome(outcome: AnalysisOutcome): string {
  const parts: string[] = [];
  if (outcome.coverage.audioDecoded) {
    parts.push(`${outcome.stats.speechRegions} speech regions`);
    parts.push(`${outcome.stats.speakers} speakers`);
  }
  if (outcome.stats.speechWindowsPlanned > 0) {
    parts.push(`${outcome.stats.dialogueSegments} transcribed dialogue segments`);
  }
  if (outcome.stats.observations > 0) {
    parts.push(`${outcome.stats.observations} observations`);
    parts.push(`${outcome.stats.sceneCuts} scene changes`);
  }
  if (outcome.stats.sceneObservations > 0) {
    parts.push(`${outcome.stats.sceneObservations} semantic scene observations`);
  }
  return parts.join(' · ') || 'nothing analyzed';
}
