/**
 * Transcription: planning, mapping, and the screenplay it produces.
 *
 * The chain under test is the one the product promise rests on:
 *
 *   VAD regions → bounded speech windows → provider result → speech evidence
 *   → the same deterministic reconstruction a subtitle file goes through
 *   → actual dialogue lines in the screenplay.
 *
 * The provider itself is mocked at the HTTP boundary; everything either side of
 * that boundary is the real implementation.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildScreenplay,
  classifyHttpFailure,
  cuesToEvidence,
  encodeAsrWindow,
  planSpeechWindows,
  retryDelayMs,
  sliceWindow,
  speakerForRange,
  transcriptToEvidence,
  transcribeWav,
  withRetry,
  FrameScriptError,
  type EvidenceEvent,
  type SpeakerEvidence,
  type SpeechRegion,
} from '@/core';

const cue = (start: number, end: number, text: string) => ({
  index: 1,
  start,
  end,
  text,
  lines: [text],
});

const region = (start: number, end: number): SpeechRegion => ({
  start,
  end,
  meanExcessDb: 12,
  peakDb: -18,
});

describe('speech window planning', () => {
  it('merges regions separated by a breath into one utterance', () => {
    const plan = planSpeechWindows([region(1_000, 2_000), region(2_200, 3_000)], {
      mergeGapMs: 400,
      padMs: 0,
    });
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]).toMatchObject({ start: 1_000, end: 3_000, continuation: false });
    expect(plan.windows[0]!.regionIndices).toEqual([0, 1]);
  });

  it('keeps regions separated by a real pause apart', () => {
    const plan = planSpeechWindows([region(0, 1_000), region(5_000, 6_000)], { padMs: 0 });
    expect(plan.windows).toHaveLength(2);
  });

  it('splits a monologue into evenly sized windows rather than max-plus-remainder', () => {
    const plan = planSpeechWindows([region(0, 60_000)], { maxWindowMs: 25_000, padMs: 0 });
    expect(plan.windows).toHaveLength(3);
    const durations = plan.windows.map((w) => w.end - w.start);
    for (const duration of durations) {
      expect(duration).toBeLessThanOrEqual(25_000);
      expect(duration).toBeGreaterThan(15_000);
    }
    expect(plan.windows[1]!.continuation).toBe(true);
    // No gaps and no overlaps: a transcript assembled from these reads in order.
    expect(plan.windows[0]!.end).toBe(plan.windows[1]!.start);
    expect(plan.windows[2]!.end).toBe(60_000);
  });

  it('pads without overlapping the previous window or running past the media', () => {
    const plan = planSpeechWindows([region(100, 1_000), region(1_800, 2_000)], {
      padMs: 500,
      mergeGapMs: 100,
      durationMs: 2_200,
    });
    expect(plan.windows[0]!.start).toBe(0);
    expect(plan.windows[1]!.start).toBeGreaterThanOrEqual(plan.windows[0]!.end);
    expect(plan.windows[1]!.end).toBeLessThanOrEqual(2_200);
  });

  it('drops fragments too short to transcribe and reports them', () => {
    const plan = planSpeechWindows([region(0, 90)], { minWindowMs: 300, padMs: 0 });
    expect(plan.windows).toHaveLength(0);
    expect(plan.skippedAsTooShortMs).toBe(90);
  });

  it('stops at the budget instead of silently transmitting a whole film', () => {
    const regions = Array.from({ length: 20 }, (_, i) => region(i * 10_000, i * 10_000 + 5_000));
    const plan = planSpeechWindows(regions, { maxTotalMs: 20_000, padMs: 0 });
    expect(plan.totalMs).toBeLessThanOrEqual(20_000);
    expect(plan.skippedForBudgetMs).toBeGreaterThan(0);
  });

  it('slices the window it planned out of the waveform', () => {
    const mono = new Float32Array(16_000);
    for (let i = 0; i < mono.length; i++) mono[i] = i / mono.length;
    const slice = sliceWindow(mono, 16_000, { start: 250, end: 750 });
    expect(slice).toHaveLength(8_000);
    expect(slice[0]).toBeCloseTo(0.25, 2);
  });
});

describe('transcription result → evidence', () => {
  const speakers: SpeakerEvidence[] = [
    {
      id: 'sp-1',
      source: 'audio-speaker',
      start: 1_000,
      end: 3_000,
      confidence: 'medium',
      provisional: false,
      payload: { speakerId: 'speaker-001' },
    },
    {
      id: 'sp-2',
      source: 'audio-speaker',
      start: 3_200,
      end: 5_000,
      confidence: 'medium',
      provisional: false,
      payload: { speakerId: 'speaker-002' },
    },
  ];

  it('attributes a line to the speaker cluster it overlaps most', () => {
    expect(speakerForRange(speakers, { start: 1_100, end: 2_000 })).toBe('speaker-001');
    expect(speakerForRange(speakers, { start: 3_300, end: 4_000 })).toBe('speaker-002');
    expect(speakerForRange(speakers, { start: 8_000, end: 9_000 })).toBeUndefined();
  });

  it('uses provider segments and clamps them into the window', () => {
    const events = transcriptToEvidence(
      { start: 1_000, end: 3_000 },
      {
        text: 'We are out of milk. I will go get some.',
        language: 'en',
        segments: [
          { startMs: 0, endMs: 900, text: 'We are out of milk.' },
          // Deliberately past the end of the window the provider was given.
          { startMs: 1_000, endMs: 9_999, text: 'I will go get some.' },
        ],
      },
      { speakers },
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.payload.text).toBe('We are out of milk.');
    expect(events[0]!.payload.speakerId).toBe('speaker-001');
    expect(events[1]!.end).toBe(3_000);
    expect(events.every((event) => event.source === 'audio-asr')).toBe(true);
  });

  it('falls back to one event per window when the provider reports no segments', () => {
    const events = transcriptToEvidence({ start: 0, end: 2_000 }, { text: 'Hello.' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: 0, end: 2_000 });
  });

  it('produces no evidence at all for an empty transcript', () => {
    expect(transcriptToEvidence({ start: 0, end: 1_000 }, { text: '   ' })).toHaveLength(0);
    expect(transcriptToEvidence({ start: 0, end: 1_000 }, { text: '', segments: [] })).toHaveLength(
      0,
    );
  });

  it('carries the provider language rather than assuming English', () => {
    const events = transcriptToEvidence(
      { start: 0, end: 1_000 },
      { text: '우유가 없네.', language: 'ko' },
    );
    expect(events[0]!.payload.language).toBe('ko');
  });
});

describe('speech evidence becomes screenplay dialogue', () => {
  const speech = (start: number, end: number, text: string, speakerId: string): EvidenceEvent => ({
    id: `asr-${start}`,
    source: 'audio-asr',
    start,
    end,
    confidence: 'medium',
    provisional: false,
    payload: { text, language: 'en', speakerId },
  });

  it('writes attributed dialogue lines from transcription alone', () => {
    const events: EvidenceEvent[] = [
      {
        id: 'spk-1',
        source: 'audio-speaker',
        start: 1_000,
        end: 3_000,
        confidence: 'medium',
        provisional: false,
        payload: { speakerId: 'speaker-001' },
      },
      speech(1_000, 3_000, 'We are out of milk.', 'speaker-001'),
      speech(4_000, 6_000, 'I will go get some.', 'speaker-002'),
    ];

    const result = buildScreenplay(events, { durationMs: 8_000 });
    const dialogue = result.scenes
      .flatMap((scene) => scene.beats)
      .filter((beat) => beat.type === 'dialogue');

    expect(dialogue).toHaveLength(2);
    expect(dialogue[0]).toMatchObject({ type: 'dialogue' });
    if (dialogue[0]!.type === 'dialogue') {
      expect(dialogue[0]!.textVariants.en?.text).toBe('We are out of milk.');
      expect(dialogue[0]!.textVariants.en?.origin).toBe('audio-asr');
      expect(dialogue[0]!.characterId).toBeTruthy();
    }
    expect(result.languages).toContain('en');
  });

  it('keeps speaker evidence alone from ever becoming dialogue', () => {
    const result = buildScreenplay(
      [
        {
          id: 'spk-only',
          source: 'audio-speaker',
          start: 1_000,
          end: 3_000,
          confidence: 'medium',
          provisional: false,
          payload: { speakerId: 'speaker-001' },
        },
      ],
      { durationMs: 4_000 },
    );
    expect(result.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'dialogue')).toHaveLength(
      0,
    );
  });

  it('fuses agreeing subtitles and transcription into one line, not three', () => {
    // The secondary acceptance case: an MP4 with EN and KO subtitle tracks and
    // transcription running as well must not render the same line three times.
    const cues = [
      ...cuesToEvidence([cue(5_000, 7_500, "We're out of milk.")], {
        language: 'en',
        idPrefix: 'en',
      }),
      ...cuesToEvidence([cue(5_000, 7_500, '우유가 없네.')], {
        language: 'ko',
        idPrefix: 'ko',
      }),
    ];
    const events: EvidenceEvent[] = [
      ...cues,
      speech(5_100, 7_400, "We're out of milk.", 'speaker-001'),
    ];

    const result = buildScreenplay(events, { durationMs: 10_000 });
    const dialogue = result.scenes
      .flatMap((scene) => scene.beats)
      .filter((beat) => beat.type === 'dialogue');

    expect(dialogue).toHaveLength(1);
    if (dialogue[0]!.type === 'dialogue') {
      expect(Object.keys(dialogue[0]!.textVariants).sort()).toEqual(['en', 'ko']);
      // The authored subtitle stays authoritative for the text.
      expect(dialogue[0]!.textVariants.en?.origin).toBe('platform-subtitle');
    }
  });

  it('records a conflict when transcription and the subtitle disagree', () => {
    const events: EvidenceEvent[] = [
      ...cuesToEvidence([cue(5_000, 7_500, 'Take an umbrella.')], {
        language: 'en',
        idPrefix: 'en',
      }),
      speech(5_100, 7_400, 'Completely different words entirely.', 'speaker-001'),
    ];
    const result = buildScreenplay(events, { durationMs: 10_000 });
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]!.description).toMatch(/transcription differs/i);
  });
});

describe('provider transport', () => {
  const wavFor = (seconds: number) => {
    const samples = new Float32Array(Math.round(16_000 * seconds));
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.4;
    return encodeAsrWindow(samples, 16_000)!;
  };

  it('encodes a mono 16 kHz WAV window', () => {
    const wav = wavFor(1);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    // 16-bit mono at 16 kHz for one second, plus a 44-byte header.
    expect(wav.byteLength).toBe(44 + 16_000 * 2);
  });

  it('refuses to build a window from a fragment too short to transcribe', () => {
    expect(encodeAsrWindow(new Float32Array(400), 16_000)).toBeNull();
  });

  it('posts the window as multipart and parses segments back', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect(form.get('response_format')).toBe('verbose_json');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return new Response(
        JSON.stringify({
          text: 'Hello there.',
          language: 'en',
          segments: [{ start: 0, end: 1.25, text: 'Hello there.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await transcribeWav({
      wav: wavFor(1),
      endpoint: 'https://provider.example/v1/audio/transcriptions',
      apiKey: 'test-key',
      model: 'whisper-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result?.text).toBe('Hello there.');
    expect(result?.segments).toEqual([{ startMs: 0, endMs: 1_250, text: 'Hello there.' }]);
  });

  it('maps provider status codes onto typed, correctly retryable errors', async () => {
    const cases: [number, string, boolean][] = [
      [429, 'ASR_RATE_LIMITED', true],
      [401, 'ASR_NOT_CONFIGURED', false],
      [400, 'ASR_PROVIDER_FAILED', false],
      [503, 'ASR_PROVIDER_FAILED', true],
    ];
    for (const [status, code, retryable] of cases) {
      expect(classifyHttpFailure(status, 'asr')).toEqual({ code, retryable });
      await expect(
        transcribeWav({
          wav: wavFor(0.5),
          endpoint: 'https://provider.example/v1/audio/transcriptions',
          apiKey: 'k',
          model: 'm',
          fetchImpl: (async () => new Response('nope', { status })) as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code, recoverable: retryable });
    }
  });

  it('never puts the provider response body into the error', async () => {
    const secret = 'sk-should-never-appear';
    await expect(
      transcribeWav({
        wav: wavFor(0.5),
        endpoint: 'https://provider.example/v1/audio/transcriptions',
        apiKey: secret,
        model: 'm',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), {
            status: 400,
          })) as unknown as typeof fetch,
      }),
    ).rejects.toSatisfy(
      (error: FrameScriptError) => !`${error.message}${error.detail ?? ''}`.includes(secret),
    );
  });
});

describe('bounded retry', () => {
  it('retries a recoverable failure and then succeeds', async () => {
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new FrameScriptError({ code: 'ASR_RATE_LIMITED', recoverable: true });
        return 'ok';
      },
      { attempts: 3, sleep },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrecoverable failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new FrameScriptError({ code: 'ASR_NOT_CONFIGURED' });
        },
        { attempts: 4, sleep: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'ASR_NOT_CONFIGURED' });
    expect(calls).toBe(1);
  });

  it('stops immediately when the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return 'never';
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_ABORTED' });
    expect(calls).toBe(0);
  });

  it('backs off exponentially and stays under the cap', () => {
    const random = () => 1;
    expect(retryDelayMs(1, { baseDelayMs: 500, random })).toBe(500);
    expect(retryDelayMs(2, { baseDelayMs: 500, random })).toBe(1_000);
    expect(retryDelayMs(9, { baseDelayMs: 500, maxDelayMs: 8_000, random })).toBe(8_000);
    // Jitter never lengthens beyond the ceiling.
    expect(retryDelayMs(3, { baseDelayMs: 500, random: () => 0 })).toBe(1_000);
  });
});
