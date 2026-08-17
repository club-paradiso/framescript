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
 * The file never leaves the device. It is read with the File API and decoded
 * locally; nothing here uploads anything.
 */

import {
  ActionSegmenter,
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
  type MediaTimeMs,
  type SilenceEvidence,
  type SoundEvidence,
  type SpeakerEvidence,
  type VisualEvidence,
} from '@/core';

export interface AnalysisProgress {
  phase: 'decoding' | 'audio' | 'video' | 'building' | 'done';
  /** 0..1 within the current phase, or undefined when indeterminate. */
  ratio?: number;
  message: string;
}

export interface LocalAnalysisOptions {
  fidelity: AnalysisFidelity;
  analyzeAudio: boolean;
  analyzeVideo: boolean;
  /** Playback rate for the video scan. Higher is faster but observes less. */
  scanRate: number;
  onProgress?: (progress: AnalysisProgress) => void;
  signal?: AbortSignal;
}

export interface LocalAnalysisResult {
  events: EvidenceEvent[];
  durationMs: MediaTimeMs;
  /** Ranges the analysis genuinely covered, per source. */
  audioCovered: boolean;
  videoObservedMs: MediaTimeMs;
  stats: {
    speechRegions: number;
    speakers: number;
    soundEvents: number;
    silences: number;
    observations: number;
    sceneCuts: number;
    actionSegments: number;
  };
}

const nextId = createIdFactory('local');

/** Offline audio analysis over the complete decoded waveform. */
export async function analyzeAudioBuffer(
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void,
): Promise<{ events: EvidenceEvent[]; stats: Pick<LocalAnalysisResult['stats'], 'speechRegions' | 'speakers' | 'soundEvents' | 'silences'> }> {
  const sampleRate = buffer.sampleRate;
  const mono = downmix(buffer);
  const events: EvidenceEvent[] = [];

  // --- Speech regions -------------------------------------------------------
  const regions = detectSpeechRegions(mono, { sampleRate });
  onProgress?.(0.4);

  // --- Speakers -------------------------------------------------------------
  const diarizer = new SpeakerDiarizer({ sampleRate });
  const speakerIds = new Set<string>();
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

/**
 * Scans the picture during playback.
 *
 * Resolves when playback reaches the end or the signal aborts. Whatever was
 * observed is what gets reported — stopping early yields partial coverage, and
 * the caller shows that rather than implying a full pass.
 */
export function scanVideoDuringPlayback(
  video: HTMLVideoElement,
  options: {
    fidelity: AnalysisFidelity;
    scanRate: number;
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<{ events: EvidenceEvent[]; observedMs: MediaTimeMs; stats: Pick<LocalAnalysisResult['stats'], 'observations' | 'sceneCuts' | 'actionSegments'> }> {
  return new Promise((resolve) => {
    const profile = profileFor(options.fidelity);
    const events: EvidenceEvent[] = [];
    const segmenter = new ActionSegmenter();
    let sceneCuts = 0;
    let actionSegments = 0;
    let observedMs = 0;
    let lastObservationAt = -Infinity;

    const emitSegment = (start: MediaTimeMs, end: MediaTimeMs, importance: number, hesitations: number) => {
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
            emitSegment(segment.start, segment.end, segment.peakImportance, segment.hesitations.length);
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
        },
      },
    });

    const canvas = document.createElement('canvas');
    canvas.width = profile.analysisWidth;
    canvas.height = profile.analysisHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      const tail = segmenter.flush();
      if (tail) emitSegment(tail.start, tail.end, tail.peakImportance, tail.hesitations.length);
      resolve({
        events,
        observedMs,
        stats: { observations: scanner.stats.observations, sceneCuts, actionSegments },
      });
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
        scanner.observe({ data: image.data, width: canvas.width, height: canvas.height, timestamp: mediaTime });
      } catch {
        // A file the browser will play but not let us read back (rare, but
        // possible for some protected containers). Stop rather than loop.
        finish();
        return;
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
    const onAbort = () => {
      video.pause();
      finish();
    };
    video.addEventListener('ended', onEnded);
    options.signal?.addEventListener('abort', onAbort);

    function cleanup() {
      if (rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      if (intervalHandle !== null) clearInterval(intervalHandle);
      video.removeEventListener('ended', onEnded);
      options.signal?.removeEventListener('abort', onAbort);
    }

    video.playbackRate = options.scanRate;
    video.muted = true;
    void video.play().catch(() => finish());
  });
}

/** Decodes a media file's audio track in full. */
export async function decodeAudio(file: File, signal?: AbortSignal): Promise<AudioBuffer | null> {
  const bytes = await file.arrayBuffer();
  if (signal?.aborted) return null;
  const context = new OfflineAudioContext(1, 1, 44_100);
  try {
    return await context.decodeAudioData(bytes);
  } catch {
    // No audio track, or a codec the browser cannot decode. Not an error —
    // video-only analysis still works.
    return null;
  }
}
