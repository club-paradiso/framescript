/**
 * Diagnostics sanitization.
 *
 * A diagnostics report is pasted into an issue by definition, so the test that
 * matters most is the one asserting what is *absent*: no transcript, no media
 * bytes, no path, no key, no endpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  describeAudioPipeline,
  formatDiagnostics,
  sanitizeFilename,
} from '../web/src/analysis/diagnostics';
import type { Capabilities } from '../web/src/analysis/apiClient';
import type { AnalysisOutcome } from '../web/src/analysis/runAnalysis';

const capabilities: Capabilities = {
  transcription: { configured: true, provider: 'openai-compatible', model: 'whisper-1' },
  vision: { configured: false, reason: 'FRAMESCRIPT_VISION_API_KEY is not set.' },
  limits: { maxAudioBytes: 1, maxWindowMs: 30_000, maxFramesPerRequest: 8, maxFrameBytes: 1 },
  endpointReachable: true,
};

const outcome: AnalysisOutcome = {
  events: [
    {
      id: 'asr-1',
      source: 'audio-asr',
      start: 0,
      end: 1_000,
      confidence: 'medium',
      provisional: false,
      payload: { text: 'A private line of dialogue nobody should paste into an issue.' },
    },
  ],
  durationMs: 177_870,
  stats: {
    speechRegions: 18,
    speakers: 3,
    soundEvents: 2,
    silences: 4,
    observations: 1_700,
    sceneCuts: 6,
    actionSegments: 9,
    speechWindowsPlanned: 18,
    speechWindowsTranscribed: 17,
    dialogueSegments: 22,
    keyframeWindows: 4,
    keyframesCaptured: 11,
    keyframeBytes: 240_000,
    sceneObservations: 8,
  },
  coverage: {
    audioDecoded: true,
    videoObservedMs: 177_000,
    durationMs: 177_870,
    transcribedRatio: 17 / 18,
  },
  notices: [
    { code: 'ASR_RATE_LIMITED', message: 'Rate limited.', detail: '429  provider\n said no  ' },
  ],
  requests: {
    asr: { attempted: 18, succeeded: 17, failed: 1 },
    vision: { attempted: 4, succeeded: 4, failed: 0 },
  },
  aborted: false,
  lastPhase: 'done',
};

const environment = { userAgent: 'TestBrowser/1.0', platform: 'TestOS', deviceMemory: 8 };

describe('diagnostics', () => {
  it('reduces a filename to a bounded base name', () => {
    expect(sanitizeFilename('/Users/someone/Movies/holiday.mp4')).toBe('holiday.mp4');
    expect(sanitizeFilename('C:\\Users\\someone\\clip.mp4')).toBe('clip.mp4');
    expect(sanitizeFilename('a\u0000b\u001fc.mp4')).toBe('abc.mp4');
    expect(sanitizeFilename(`${'x'.repeat(400)}.mp4`).length).toBeLessThanOrEqual(120);
  });

  it('records the failing phase, the counts and the configuration status', () => {
    const report = buildDiagnostics({
      version: '0.1.0',
      file: { name: 'clip.mp4', size: 108_700_000, type: 'video/mp4' },
      media: { durationMs: 177_870, videoWidth: 910, videoHeight: 512 },
      capabilities,
      outcome,
      environment,
    });

    expect(report.analysis?.lastPhase).toBe('done');
    expect(report.analysis?.stats.speechRegions).toBe(18);
    expect(report.analysis?.requests.asr).toEqual({ attempted: 18, succeeded: 17, failed: 1 });
    expect(report.analysis?.audioPipeline).toEqual({
      decode: 'decoded',
      speechAnalysis: 'completed',
      transcription: { state: 'partial', attempted: 18, succeeded: 17, failed: 1 },
    });
    expect(report.configuration.transcription).toMatchObject({
      configured: true,
      provider: 'openai-compatible',
      model: 'whisper-1',
    });
    expect(report.configuration.vision.configured).toBe(false);
    expect(report.media).toEqual({ durationMs: 177_870, width: 910, height: 512 });
    expect(report.file).toEqual({ name: 'clip.mp4', sizeBytes: 108_700_000, type: 'video/mp4' });
  });

  it('explains that ASR never ran when browser audio decoding failed', () => {
    const failedDecode: AnalysisOutcome = {
      ...outcome,
      events: [],
      stats: {
        ...outcome.stats,
        speechRegions: 0,
        speakers: 0,
        soundEvents: 0,
        silences: 0,
        speechWindowsPlanned: 0,
        speechWindowsTranscribed: 0,
        dialogueSegments: 0,
      },
      coverage: { ...outcome.coverage, audioDecoded: false, transcribedRatio: undefined },
      notices: [
        {
          code: 'AUDIO_DECODE_UNSUPPORTED',
          message: 'Unsupported audio.',
          detail: 'EncodingError: Decoding failed',
        },
      ],
      requests: {
        ...outcome.requests,
        asr: { attempted: 0, succeeded: 0, failed: 0 },
      },
    };

    expect(describeAudioPipeline(failedDecode)).toEqual({
      decode: 'unsupported',
      speechAnalysis: 'not-run',
      transcription: {
        state: 'not-attempted-audio-unavailable',
        attempted: 0,
        succeeded: 0,
        failed: 0,
      },
    });

    const report = buildDiagnostics({
      version: '0.1.0',
      file: { name: 'iphone.mov', size: 352_898_489, type: 'video/quicktime' },
      media: { durationMs: 177_850, videoWidth: 1920, videoHeight: 1080 },
      capabilities,
      outcome: failedDecode,
      environment,
    });

    expect(report.analysis?.audioPipeline.transcription.state).toBe(
      'not-attempted-audio-unavailable',
    );
    expect(report.analysis?.notices[0]).toEqual({
      code: 'AUDIO_DECODE_UNSUPPORTED',
      detail: 'EncodingError: Decoding failed',
    });
  });

  it('distinguishes decoded audio with no detected speech from a decode failure', () => {
    const noSpeech: AnalysisOutcome = {
      ...outcome,
      events: [],
      stats: {
        ...outcome.stats,
        speechRegions: 0,
        speakers: 0,
        speechWindowsPlanned: 0,
        speechWindowsTranscribed: 0,
        dialogueSegments: 0,
      },
      notices: [],
      requests: {
        ...outcome.requests,
        asr: { attempted: 0, succeeded: 0, failed: 0 },
      },
    };

    expect(describeAudioPipeline(noSpeech).transcription.state).toBe(
      'not-attempted-no-speech',
    );
  });

  it('does not call an interrupted transcription complete', () => {
    const interrupted: AnalysisOutcome = {
      ...outcome,
      stats: {
        ...outcome.stats,
        speechWindowsPlanned: 18,
        speechWindowsTranscribed: 0,
        dialogueSegments: 0,
      },
      requests: {
        ...outcome.requests,
        asr: { attempted: 1, succeeded: 0, failed: 0 },
      },
      aborted: true,
    };

    expect(describeAudioPipeline(interrupted).transcription).toEqual({
      state: 'partial',
      attempted: 1,
      succeeded: 0,
      failed: 0,
    });
  });

  it('derives unavailable transcription from the reported capabilities', () => {
    const unavailableCapabilities: Capabilities = {
      ...capabilities,
      transcription: { configured: false, reason: 'No transcription provider configured.' },
    };
    const noAttempt: AnalysisOutcome = {
      ...outcome,
      events: [],
      stats: {
        ...outcome.stats,
        speechWindowsPlanned: 0,
        speechWindowsTranscribed: 0,
        dialogueSegments: 0,
      },
      notices: [],
      requests: {
        ...outcome.requests,
        asr: { attempted: 0, succeeded: 0, failed: 0 },
      },
    };

    const report = buildDiagnostics({
      version: '0.1.0',
      file: { name: 'clip.mp4', size: 10, type: 'video/mp4' },
      media: {},
      capabilities: unavailableCapabilities,
      outcome: noAttempt,
      environment,
    });

    expect(report.analysis?.audioPipeline.transcription.state).toBe(
      'not-attempted-not-configured',
    );
  });

  it('carries no transcript, no evidence and no media bytes', () => {
    const text = formatDiagnostics(
      buildDiagnostics({
        version: '0.1.0',
        file: { name: 'clip.mp4', size: 10, type: 'video/mp4' },
        media: {},
        capabilities,
        outcome,
        environment,
      }),
    );

    expect(text).not.toContain('private line of dialogue');
    expect(text).not.toContain('"events"');
    expect(text).not.toContain('payload');
    // The notice is present, but only as a code and a collapsed detail.
    expect(text).toContain('ASR_RATE_LIMITED');
    expect(JSON.parse(text).analysis.notices[0].detail).toBe('429 provider said no');
  });

  it('works before an analysis has run', () => {
    const report = buildDiagnostics({
      version: '0.1.0',
      file: { name: 'clip.mp4', size: 10, type: 'video/mp4' },
      media: {},
      capabilities,
      environment,
    });
    expect(report.analysis).toBeUndefined();
    expect(report.browser).toEqual({
      userAgent: 'TestBrowser/1.0',
      platform: 'TestOS',
      deviceMemoryGb: 8,
    });
  });
});
