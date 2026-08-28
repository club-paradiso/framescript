/**
 * Local media analysis for the web app.
 *
 * Runs the *same* engine as the extension over a file the user chose
 * themselves. Two things differ from the extension, and both are improvements
 * that only a local file makes possible:
 *
 *  1. **Audio is analyzed offline, in full.** `decodeAudioData` gives the whole
 *     waveform at once, so VAD, diarization, sound events and silence run over
 *     complete audio far faster than real time, with genuine 100% coverage.
 *
 *  2. **Video is scanned during playback**, because there is no fast way to get
 *     arbitrary frames from an arbitrary container in a browser without a
 *     demuxer. Playback can be accelerated, and coverage is reported honestly
 *     for whatever was actually observed.
 *
 * The file is read with the File API and decoded locally. Nothing in this
 * module uploads anything: the only bytes that can ever leave the device are
 * the short speech windows and selected keyframes that
 * `web/src/analysis/runAnalysis.ts` hands to the same-origin API, and each of
 * those is derived here, bounded here, and released here.
 *
 * Failures are typed. "Returned null" used to mean five unrelated things —
 * no audio track, an undecodable codec, an aborted run, a protected file — and
 * the user got the same shrug for all of them.
 */

import {
  ActionSegmenter,
  FrameScriptError,
  SoundEventDetector,
  SpeakerDiarizer,
  TemporalScanner,
  createIdFactory,
  detectSpeechRegions,
  findSilences,
  fromScore,
  profileFor,
  secondsToMs,
  type AnalysisFidelity,
  type EvidenceEvent,
  type FrameScriptErrorCode,
  type MediaTimeMs,
  type SilenceEvidence,
  type SoundEvidence,
  type SpeakerEvidence,
  type SpeechRegion,
  type VisualEvidence,
} from '@/core';

const nextId = createIdFactory('local');

// --- Audio decoding -------------------------------------------------------------

export type DecodeAudioResult =
  { ok: true; buffer: AudioBuffer } | { ok: false; code: FrameScriptErrorCode; detail: string };

/**
 * Decodes a media file's audio track in full.
 *
 * `decodeAudioData` detaches the ArrayBuffer it is given, so the encoded copy
 * is released by the browser the moment decoding starts and the peak is the
 * decoded PCM rather than PCM *plus* the original file. That matters: a
 * hundred-megabyte MP4 decodes to several hundred megabytes of Float32, and
 * holding the container alongside it is what pushes a phone over the edge.
 *
 * `hasAudioTrack` distinguishes "this file has no audio" from "this browser
 * cannot decode this file's audio", which are the same exception but very
 * different advice.
 */
export async function decodeAudioTrack(
  file: File,
  options: { signal?: AbortSignal; hasAudioTrack?: boolean | undefined } = {},
): Promise<DecodeAudioResult> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (error) {
    return {
      ok: false,
      code: isAllocationFailure(error) ? 'MEMORY_PRESSURE' : 'AUDIO_DECODE_FAILED',
      detail: describe(error),
    };
  }
  if (options.signal?.aborted) {
    return { ok: false, code: 'ANALYSIS_ABORTED', detail: 'aborted before decode' };
  }

  const context = new OfflineAudioContext(1, 1, 44_100);
  try {
    const buffer = await context.decodeAudioData(bytes);
    return { ok: true, buffer };
  } catch (error) {
    if (options.hasAudioTrack === false) {
      return { ok: false, code: 'NO_AUDIO_TRACK', detail: 'element reported no decoded audio' };
    }
    if (isAllocationFailure(error)) {
      return { ok: false, code: 'MEMORY_PRESSURE', detail: describe(error) };
    }
    // EncodingError is what Chromium and Safari both raise for a container or
    // codec they will not decode, and for a file with no audio stream at all.
    return { ok: false, code: 'AUDIO_DECODE_UNSUPPORTED', detail: describe(error) };
  }
}

/**
 * Best-effort answer to "does this file even have audio?".
 *
 * Chromium exposes a decoded-byte counter that is zero for a video-only file
 * and non-zero as soon as any audio has been decoded. It is non-standard and
 * absent elsewhere, so `undefined` means "unknown" and the caller must not
 * claim either way.
 */
export function probeAudioTrack(video: HTMLVideoElement): boolean | undefined {
  const counter = (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number })
    .webkitAudioDecodedByteCount;
  if (typeof counter !== 'number') return undefined;
  return counter > 0;
}

// --- Audio evidence -------------------------------------------------------------

export interface AudioAnalysisResult {
  events: EvidenceEvent[];
  /** Mono waveform, retained only until transcription windows are cut from it. */
  mono: Float32Array;
  sampleRate: number;
  regions: SpeechRegion[];
  speakers: SpeakerEvidence[];
  stats: { speechRegions: number; speakers: number; soundEvents: number; silences: number };
}

/** Offline audio analysis over the complete decoded waveform. */
export async function analyzeAudioBuffer(
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void,
): Promise<AudioAnalysisResult> {
  const sampleRate = buffer.sampleRate;
  const mono = downmix(buffer);
  const events: EvidenceEvent[] = [];

  // --- Speech regions -------------------------------------------------------
  const regions = detectSpeechRegions(mono, { sampleRate });
  onProgress?.(0.4);

  // --- Speakers -------------------------------------------------------------
  const diarizer = new SpeakerDiarizer({ sampleRate });
  const speakerIds = new Set<string>();
  const speakers: SpeakerEvidence[] = [];
  for (const region of regions) {
    const from = Math.floor((region.start / 1000) * sampleRate);
    const to = Math.min(mono.length, Math.ceil((region.end / 1000) * sampleRate));
    if (to <= from) continue;

    const assignment = diarizer.assign(mono.subarray(from, to), region.start, region.end);
    if (!assignment) continue;
    speakerIds.add(assignment.speakerId);

    const event: SpeakerEvidence = {
      id: nextId(),
      source: 'audio-speaker',
      start: assignment.start,
      end: assignment.end,
      confidence: assignment.confidence,
      provisional: false,
      payload: {
        speakerId: assignment.speakerId,
        distance: Math.round(assignment.distance * 1000) / 1000,
        ...(assignment.turnChange ? { turnChange: true } : {}),
      },
    };
    speakers.push(event);
    events.push(event);
  }
  onProgress?.(0.7);

  // --- Sound events ---------------------------------------------------------
  const detector = new SoundEventDetector({ sampleRate });
  // Feed in chunks so a long film does not build one enormous intermediate.
  const chunkSamples = sampleRate * 10;
  let soundCount = 0;
  for (let offset = 0; offset < mono.length; offset += chunkSamples) {
    const chunk = mono.subarray(offset, Math.min(offset + chunkSamples, mono.length));
    const startMs = Math.round((offset / sampleRate) * 1000);
    for (const onset of detector.push(chunk, startMs)) {
      const event: SoundEvidence = {
        id: nextId(),
        source: 'audio-event',
        start: onset.timestamp,
        end: onset.timestamp + 250,
        confidence: onset.classified ? 'low' : 'unknown',
        provisional: false,
        payload: { kind: onset.kind, prominenceDb: Math.round(onset.prominenceDb * 10) / 10 },
      };
      events.push(event);
      soundCount++;
    }
  }
  onProgress?.(0.9);

  // --- Silence --------------------------------------------------------------
  const silences = findSilences(regions);
  for (const gap of silences) {
    if (!gap.significant) continue;
    const event: SilenceEvidence = {
      id: nextId(),
      source: 'audio-silence',
      start: gap.start,
      end: gap.end,
      confidence: 'medium',
      provisional: false,
      payload: { durationMs: gap.durationMs, significant: true },
    };
    events.push(event);
  }
  onProgress?.(1);

  return {
    events,
    mono,
    sampleRate,
    regions,
    speakers,
    stats: {
      speechRegions: regions.length,
      speakers: speakerIds.size,
      soundEvents: soundCount,
      silences: silences.filter((s) => s.significant).length,
    },
  };
}

function downmix(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

// --- Video ----------------------------------------------------------------------

/** Waits for metadata, mapping the element's error codes onto typed failures. */
export function loadMediaMetadata(video: HTMLVideoElement, timeoutMs = 20_000): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (error?: FrameScriptError) => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => done();
    const onError = () => {
      // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED, 3 = MEDIA_ERR_DECODE.
      const code = video.error?.code === 4 ? 'VIDEO_CODEC_UNSUPPORTED' : 'VIDEO_METADATA_FAILED';
      done(new FrameScriptError({ code, detail: `media error ${video.error?.code ?? 'unknown'}` }));
    };
    const timer = setTimeout(
      () =>
        done(new FrameScriptError({ code: 'VIDEO_METADATA_FAILED', detail: 'metadata timeout' })),
      timeoutMs,
    );
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export interface CapturedFrame {
  timestamp: MediaTimeMs;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface KeyframeWindow {
  start: MediaTimeMs;
  end: MediaTimeMs;
  frames: CapturedFrame[];
  /** Local salience, used to order windows when the budget is tight. */
  importance: number;
}

export interface VideoScanResult {
  events: EvidenceEvent[];
  observedMs: MediaTimeMs;
  /** Windows of selected keyframes, ready for optional semantic analysis. */
  keyframeWindows: KeyframeWindow[];
  /** Set when the picture could not be read back; local audio is unaffected. */
  failure?: { code: FrameScriptErrorCode; detail: string };
  stats: {
    observations: number;
    sceneCuts: number;
    actionSegments: number;
    keyframesCaptured: number;
    keyframeBytes: number;
  };
}

export interface VideoScanOptions {
  fidelity: AnalysisFidelity;
  /** Playback rate for the video scan. Higher is faster but observes less. */
  scanRate: number;
  /** Zero disables keyframe capture entirely, and with it any picture upload. */
  maxKeyframeWindows: number;
  maxFramesPerWindow?: number;
  /** Longest span of a keyframe window, in media time. */
  windowMs?: number;
  captureWidth?: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

const CAPTURE_MIME = 'image/jpeg';
const CAPTURE_QUALITY = 0.72;

/**
 * Scans the picture during playback.
 *
 * Resolves when playback reaches the end or the signal aborts. Whatever was
 * observed is what gets reported — stopping early yields partial coverage, and
 * the caller shows that rather than implying a full pass.
 *
 * Keyframes are captured only inside a window opened by a scene cut or the
 * start of a sustained action, at most `maxFramesPerWindow` per window and at
 * most `maxKeyframeWindows` windows for the whole file. There is no code path
 * that captures every frame, and none that retains a frame after its window has
 * been handed to the caller.
 */
export function scanVideoDuringPlayback(
  video: HTMLVideoElement,
  options: VideoScanOptions,
): Promise<VideoScanResult> {
  return new Promise((resolve) => {
    const profile = profileFor(options.fidelity);
    const events: EvidenceEvent[] = [];
    const segmenter = new ActionSegmenter();
    const keyframeWindows: KeyframeWindow[] = [];
    const maxFramesPerWindow = options.maxFramesPerWindow ?? 3;
    const windowMs = options.windowMs ?? 2_400;
    const captureWidth = options.captureWidth ?? 512;

    let sceneCuts = 0;
    let actionSegments = 0;
    let observedMs = 0;
    let lastObservationAt = -Infinity;
    let keyframesCaptured = 0;
    let keyframeBytes = 0;
    let failure: { code: FrameScriptErrorCode; detail: string } | undefined;

    /** The window currently accepting frames, if any. */
    let open: (KeyframeWindow & { lastCaptureAt: number }) | null = null;

    const closeWindow = () => {
      if (!open) return;
      const { lastCaptureAt: _drop, ...rest } = open;
      if (rest.frames.length > 0) keyframeWindows.push(rest);
      open = null;
    };

    const openWindow = (timestamp: MediaTimeMs, importance: number) => {
      if (options.maxKeyframeWindows <= 0) return;
      if (keyframeWindows.length >= options.maxKeyframeWindows) return;
      if (open) return;
      open = {
        start: timestamp,
        end: timestamp + windowMs,
        frames: [],
        importance,
        lastCaptureAt: -Infinity,
      };
    };

    const emitSegment = (
      start: MediaTimeMs,
      end: MediaTimeMs,
      importance: number,
      hesitations: number,
    ) => {
      actionSegments++;
      const event: VisualEvidence = {
        id: nextId(),
        source: 'video',
        start,
        end,
        confidence: fromScore(importance),
        provisional: false,
        payload: {
          kind: 'action',
          metrics: { motionScore: importance },
          ...(hesitations > 0 ? { hesitationCount: hesitations } : {}),
        },
      };
      events.push(event);
    };

    const scanner = new TemporalScanner({
      profile,
      callbacks: {
        onTemporalEvent: (event) => {
          const segment = segmenter.push(event);
          if (segment) {
            emitSegment(
              segment.start,
              segment.end,
              segment.peakImportance,
              segment.hesitations.length,
            );
            openWindow(segment.start, segment.peakImportance);
          }
        },
        onSceneCut: (timestamp, score) => {
          sceneCuts++;
          const event: VisualEvidence = {
            id: nextId(),
            source: 'video',
            start: timestamp,
            confidence: fromScore(score, { strongEvidence: true }),
            provisional: false,
            payload: { kind: 'scene-change', metrics: { sceneCutScore: score } },
          };
          events.push(event);
          // A cut is the strongest signal that the *next* couple of seconds are
          // worth describing, so it takes priority over an already-open window.
          closeWindow();
          openWindow(timestamp, Math.max(score, 0.6));
        },
      },
    });

    const canvas = document.createElement('canvas');
    canvas.width = profile.analysisWidth;
    canvas.height = profile.analysisHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const captureCanvas = document.createElement('canvas');
    const captureContext = captureCanvas.getContext('2d');

    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      const tail = segmenter.flush();
      if (tail) emitSegment(tail.start, tail.end, tail.peakImportance, tail.hesitations.length);
      closeWindow();
      resolve({
        events,
        observedMs,
        keyframeWindows,
        ...(failure ? { failure } : {}),
        stats: {
          observations: scanner.stats.observations,
          sceneCuts,
          actionSegments,
          keyframesCaptured,
          keyframeBytes,
        },
      });
    };

    /** Encodes the current video frame at capture resolution. Synchronous. */
    const captureFrame = (mediaTime: MediaTimeMs): void => {
      if (!captureContext || !open) return;
      if (open.frames.length >= maxFramesPerWindow) return;
      if (mediaTime - open.lastCaptureAt < 400) return;

      const sourceWidth = video.videoWidth || captureWidth;
      const sourceHeight = video.videoHeight || Math.round((captureWidth * 9) / 16);
      const width = Math.min(captureWidth, sourceWidth);
      const height = Math.max(1, Math.round((width / sourceWidth) * sourceHeight));
      if (captureCanvas.width !== width || captureCanvas.height !== height) {
        captureCanvas.width = width;
        captureCanvas.height = height;
      }
      try {
        captureContext.drawImage(video, 0, 0, width, height);
        const url = captureCanvas.toDataURL(CAPTURE_MIME, CAPTURE_QUALITY);
        const base64 = url.slice(url.indexOf(',') + 1);
        if (!base64) return;
        open.frames.push({ timestamp: mediaTime, base64, mimeType: CAPTURE_MIME, width, height });
        open.lastCaptureAt = mediaTime;
        keyframesCaptured++;
        keyframeBytes += Math.round((base64.length * 3) / 4);
      } catch {
        // Readback refused. Structural observation already failed above if it
        // was going to, so this only disables the semantic path.
        open = null;
      }
    };

    const observe = () => {
      if (stopped || !context || video.readyState < 2) return;
      const mediaTime = secondsToMs(video.currentTime);

      // Honour the profile's interval in media time, so a 4x scan does not
      // observe four times as often as the fidelity asks for.
      const minGap = profile.temporalIntervalMs * 0.5;
      if (minGap > 0 && mediaTime - lastObservationAt < minGap) return;
      lastObservationAt = mediaTime;
      observedMs = Math.max(observedMs, mediaTime);

      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        scanner.observe({
          data: image.data,
          width: canvas.width,
          height: canvas.height,
          timestamp: mediaTime,
        });
      } catch (error) {
        // A file the browser will play but not let us read back (rare, but
        // possible for some protected containers). Report it as its own state
        // rather than pretending the scan simply ended.
        failure = { code: 'CANVAS_READBACK_FAILED', detail: describe(error) };
        finish();
        return;
      }

      if (open) {
        if (mediaTime > open.end) closeWindow();
        else captureFrame(mediaTime);
      }

      if (video.duration > 0) options.onProgress?.(video.currentTime / video.duration);
    };

    // Prefer presented-frame callbacks; fall back to an interval.
    let rvfcHandle: number | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = () => {
        if (stopped) return;
        observe();
        rvfcHandle = video.requestVideoFrameCallback(tick);
      };
      rvfcHandle = video.requestVideoFrameCallback(tick);
    } else {
      intervalHandle = setInterval(observe, Math.max(16, profile.temporalIntervalMs || 100));
    }

    const onEnded = () => finish();
    const onError = () => {
      failure = {
        code: 'VIDEO_PLAYBACK_FAILED',
        detail: `media error ${video.error?.code ?? 'unknown'}`,
      };
      finish();
    };
    const onAbort = () => {
      video.pause();
      finish();
    };
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    options.signal?.addEventListener('abort', onAbort);

    function cleanup() {
      if (rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      if (intervalHandle !== null) clearInterval(intervalHandle);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
      // Drop the analysis surfaces immediately; a paused tab should not hold
      // two canvases' worth of pixels for the rest of the session.
      canvas.width = 0;
      canvas.height = 0;
      captureCanvas.width = 0;
      captureCanvas.height = 0;
    }

    if (options.signal?.aborted) {
      finish();
      return;
    }

    video.playbackRate = options.scanRate;
    video.muted = true;
    void video.play().catch((error: unknown) => {
      failure = { code: 'VIDEO_PLAYBACK_FAILED', detail: describe(error) };
      finish();
    });
  });
}

// --- Shared helpers -------------------------------------------------------------

function describe(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isAllocationFailure(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (error instanceof DOMException && error.name === 'QuotaExceededError') ||
    (error instanceof Error && /allocation|out of memory/i.test(error.message))
  );
}
