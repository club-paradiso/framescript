import { describe, expect, it, vi } from 'vitest';
import { extractJson, formatIssues, v } from '@/ai/validation';
import {
  buildVisionUserPrompt,
  validateVisionAnalysis,
  VISION_SYSTEM_PROMPT,
} from '@/ai/schemas/visionWindow';
import { InferenceCoordinator } from '@/ai/coordinator';
import {
  LocalHeuristicVisionProvider,
  LocalSoundEventProvider,
  NullSpeechRecognitionProvider,
  NullTranslationProvider,
  RegionOnlyOcrProvider,
} from '@/ai/providers/local';
import type { VisionAnalysisProvider, VisionWindowRequest } from '@/ai/types';

const frame = (timestamp: number) => ({
  timestamp,
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'image/jpeg',
  width: 480,
  height: 270,
});

const request = (overrides: Partial<VisionWindowRequest> = {}): VisionWindowRequest => ({
  start: 10_000,
  end: 11_200,
  frames: [frame(10_000), frame(10_400), frame(10_800), frame(11_200)],
  metrics: { motionScore: 0.5, sceneCutScore: 0.1, faceChangeScore: 0.2 },
  dialogue: [],
  soundEvents: [],
  knownCharacters: [],
  ...overrides,
});

describe('validators', () => {
  it('validates strings with bounds and trims', () => {
    expect(v.string({ min: 2 }).validate('  hi  ')).toEqual({ ok: true, value: 'hi' });
    expect(v.string({ min: 5 }).validate('hi').ok).toBe(false);
    // Over-long strings are truncated rather than rejected: still useful.
    expect(v.string({ max: 3 }).validate('abcdef')).toEqual({ ok: true, value: 'abc' });
    expect(v.string().validate(42).ok).toBe(false);
  });

  it('validates numbers, coercing numeric strings', () => {
    expect(v.number().validate('42')).toEqual({ ok: true, value: 42 });
    expect(v.number({ min: 0 }).validate(-1).ok).toBe(false);
    expect(v.number().validate(Number.NaN).ok).toBe(false);
    expect(v.number({ integer: true }).validate(1.5).ok).toBe(false);
  });

  it('validates literal unions', () => {
    const validator = v.literalUnion(['high', 'low'] as const);
    expect(validator.validate('high').ok).toBe(true);
    expect(validator.validate('medium').ok).toBe(false);
  });

  it('gives partial credit on arrays when asked', () => {
    const lenient = v.array(v.number(), { skipInvalid: true });
    expect(lenient.validate([1, 'x', 3])).toEqual({ ok: true, value: [1, 3] });
    // Strict mode rejects the whole array.
    expect(v.array(v.number()).validate([1, 'x', 3]).ok).toBe(false);
  });

  it('reports missing required object fields with paths', () => {
    const validator = v.object({ a: v.string(), b: v.number() }, ['b']);
    expect(validator.validate({ a: 'x' }).ok).toBe(true);

    const missing = validator.validate({ b: 1 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(formatIssues(missing.issues)).toContain('$.a');
  });

  it('rejects arrays and null where an object is required', () => {
    const validator = v.object({ a: v.string() });
    expect(validator.validate([]).ok).toBe(false);
    expect(validator.validate(null).ok).toBe(false);
  });
});

describe('JSON extraction', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON from a fenced code block', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON surrounded by prose', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns undefined for genuinely malformed output rather than guessing', () => {
    expect(extractJson('{"a": ')).toBeUndefined();
    expect(extractJson('no json at all')).toBeUndefined();
  });
});

describe('vision analysis validation', () => {
  it('accepts and normalizes a well-formed response', () => {
    const analysis = validateVisionAnalysis({
      actions: [{ offsetMs: 200, description: 'He reaches for the handle.', confidence: 'medium' }],
      characters: [{ label: 'man in blue coat', present: true, enters: true }],
      settingChanges: [],
      text: [],
      uncertainties: ['Cannot see the second figure clearly.'],
    });

    expect(analysis!.actions).toHaveLength(1);
    expect(analysis!.actions[0]!.participants).toEqual([]);
    expect(analysis!.characters[0]!.enters).toBe(true);
    expect(analysis!.uncertainties).toHaveLength(1);
  });

  it('fills missing arrays with empty ones rather than failing', () => {
    const analysis = validateVisionAnalysis({});
    expect(analysis).not.toBeNull();
    expect(analysis!.actions).toEqual([]);
  });

  it('defaults a missing confidence to unknown rather than assuming high', () => {
    const analysis = validateVisionAnalysis({ actions: [{ offsetMs: 0, description: 'Something happens.' }] });
    expect(analysis!.actions[0]!.confidence).toBe('unknown');
  });

  it('rejects a response whose action is missing its description', () => {
    // skipInvalid drops the bad entry rather than inventing text for it.
    const analysis = validateVisionAnalysis({ actions: [{ offsetMs: 0 }] });
    expect(analysis!.actions).toHaveLength(0);
  });

  it('rejects a non-object response outright', () => {
    expect(validateVisionAnalysis('a description of the scene')).toBeNull();
    expect(validateVisionAnalysis(null)).toBeNull();
    expect(validateVisionAnalysis([1, 2, 3])).toBeNull();
  });

  it('caps how many actions one window may produce', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ offsetMs: i * 10, description: `Action ${i}` }));
    expect(validateVisionAnalysis({ actions: many })!.actions.length).toBeLessThanOrEqual(12);
  });
});

describe('vision prompting', () => {
  it('instructs the provider to describe progression, not caption stills', () => {
    expect(VISION_SYSTEM_PROMPT).toContain('ORDERED SEQUENCE');
    expect(VISION_SYSTEM_PROMPT).toContain('progression');
    // The guardrails that keep it from inventing people.
    expect(VISION_SYSTEM_PROMPT).toContain("Never state a real person's or actor's name");
    expect(VISION_SYSTEM_PROMPT).toContain('Report only what is visible');
  });

  it('sends frame offsets so temporal order survives the wire', () => {
    const prompt = buildVisionUserPrompt(request());
    expect(prompt).toContain('FRAME OFFSETS');
    expect(prompt).toContain('0, 400, 800, 1200');
  });

  it('includes the dialogue and sound that occurred in the same window', () => {
    const prompt = buildVisionUserPrompt(
      request({
        dialogue: [{ start: 10_500, speakerId: 'speaker-001', text: 'Daniel?' }],
        soundEvents: [{ start: 10_200, kind: 'impact' }],
      }),
    );
    expect(prompt).toContain('+500ms speaker-001: Daniel?');
    expect(prompt).toContain('+200ms impact');
  });

  it('states plainly when there is no dialogue', () => {
    expect(buildVisionUserPrompt(request())).toContain('DIALOGUE IN THIS WINDOW: none');
  });

  it('passes local change metrics so the model knows where to look', () => {
    expect(buildVisionUserPrompt(request())).toContain('motion=0.500');
  });
});

describe('inference coordinator', () => {
  const analysis = { actions: [], characters: [], settingChanges: [], text: [], uncertainties: [] };

  function provider(impl: VisionAnalysisProvider['analyzeWindow']): VisionAnalysisProvider {
    return {
      info: { id: 'test', label: 'test', kind: 'remote', dataLeavingDevice: 'test' },
      isAvailable: async () => ({ available: true }),
      analyzeWindow: impl,
    };
  }

  it('returns provider results', async () => {
    const coordinator = new InferenceCoordinator({ provider: provider(async () => analysis) });
    expect(await coordinator.submit(request(), 0.5)).toEqual(analysis);
    expect(coordinator.stats.completed).toBe(1);
  });

  it('drops the least important request when the queue is full', async () => {
    let resolveGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const coordinator = new InferenceCoordinator({
      provider: provider(async () => {
        await gate;
        return analysis;
      }),
      maxQueueLength: 2,
      maxConcurrency: 1,
    });

    // Saturate: one in flight, then fill the queue.
    const inFlight = coordinator.submit(request(), 0.9);
    const low = coordinator.submit(request(), 0.1);
    const mid = coordinator.submit(request(), 0.5);
    const high = coordinator.submit(request(), 0.95);

    // The lowest-importance request is evicted, not the newest.
    expect(await low).toBeNull();
    resolveGate!();
    await Promise.all([inFlight, mid, high]);
    expect(coordinator.stats.dropped).toBeGreaterThanOrEqual(1);
  });

  it('degrades to null instead of throwing when the provider fails', async () => {
    const coordinator = new InferenceCoordinator({
      provider: provider(async () => {
        throw new Error('provider exploded');
      }),
    });
    // Analysis failing must never break playback or reject into caller code.
    expect(await coordinator.submit(request(), 0.5)).toBeNull();
    expect(coordinator.stats.failed).toBe(1);
  });

  it('opens a circuit breaker after repeated failures instead of retrying forever', async () => {
    const attempts = vi.fn(async () => {
      throw new Error('down');
    });
    const coordinator = new InferenceCoordinator({
      provider: provider(attempts),
      failureThreshold: 3,
      maxConcurrency: 1,
    });

    for (let i = 0; i < 3; i++) await coordinator.submit(request(), 0.5);
    expect(coordinator.stats.breakerOpen).toBe(true);

    const callsBefore = attempts.mock.calls.length;
    await coordinator.submit(request(), 0.5);
    // No further provider calls while the breaker is open.
    expect(attempts.mock.calls.length).toBe(callsBefore);
  });

  it('closes the breaker after the cooldown', async () => {
    let now = 0;
    let shouldFail = true;
    const coordinator = new InferenceCoordinator({
      provider: provider(async () => {
        if (shouldFail) throw new Error('down');
        return analysis;
      }),
      failureThreshold: 2,
      breakerCooldownMs: 1_000,
      maxConcurrency: 1,
      now: () => now,
    });

    for (let i = 0; i < 2; i++) await coordinator.submit(request(), 0.5);
    expect(coordinator.stats.breakerOpen).toBe(true);

    now = 2_000;
    shouldFail = false;
    expect(await coordinator.submit(request(), 0.5)).toEqual(analysis);
  });

  it('cancels everything pending on clear', async () => {
    const coordinator = new InferenceCoordinator({
      provider: provider(() => new Promise(() => {})),
      maxConcurrency: 1,
    });
    coordinator.submit(request(), 0.9);
    const pending = coordinator.submit(request(), 0.5);
    coordinator.clear();
    expect(await pending).toBeNull();
  });
});

describe('local providers', () => {
  it('describes change and admits it cannot identify what moved', async () => {
    const provider = new LocalHeuristicVisionProvider();
    const result = await provider.analyzeWindow(request({ metrics: { motionScore: 0.5, sceneCutScore: 0.1 } }));

    expect(result!.actions.length).toBeGreaterThan(0);
    expect(result!.uncertainties.some((u) => u.includes('not identified'))).toBe(true);
    // It must never claim to see people or objects.
    expect(result!.characters).toEqual([]);
  });

  it('reports a shot change on a strong cut', async () => {
    const provider = new LocalHeuristicVisionProvider();
    const result = await provider.analyzeWindow(request({ metrics: { sceneCutScore: 0.9, motionScore: 0.1 } }));
    expect(result!.actions.some((a) => a.description === 'The shot changes.')).toBe(true);
  });

  it('flags a black frame as having no visual detail', async () => {
    const provider = new LocalHeuristicVisionProvider();
    const result = await provider.analyzeWindow(request({ metrics: { motionScore: 0.1, luminance: 0.01 } }));
    expect(result!.uncertainties.some((u) => u.includes('black'))).toBe(true);
  });

  it('reports ASR as unavailable with an actionable reason', async () => {
    const provider = new NullSpeechRecognitionProvider();
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('platform subtitles');
    expect(
      await provider.transcribe({ samples: new Float32Array(1000), sampleRate: 16_000, start: 0, end: 1000 }),
    ).toBeNull();
  });

  it('returns no OCR text rather than inventing characters', async () => {
    const provider = new RegionOnlyOcrProvider();
    expect(await provider.recognize({ frame: frame(0) })).toEqual([]);
    expect((await provider.isAvailable()).reason).toContain('does not read it');
  });

  it('labels local sound classification as weak', async () => {
    const provider = new LocalSoundEventProvider();
    const samples = new Float32Array(2048);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 1000 * i) / 16_000) * 0.5;

    const result = await provider.classify({ samples, sampleRate: 16_000, start: 0, end: 128 });
    expect(result).not.toBeNull();
    // Never better than low from a handful of spectral features.
    expect(['low', 'unknown']).toContain(result!.confidence);
  });

  it('returns nothing for silence', async () => {
    const provider = new LocalSoundEventProvider();
    expect(
      await provider.classify({ samples: new Float32Array(2048), sampleRate: 16_000, start: 0, end: 128 }),
    ).toBeNull();
  });

  it('reports translation as unavailable without a provider', async () => {
    const provider = new NullTranslationProvider();
    expect((await provider.isAvailable()).available).toBe(false);
    expect(await provider.translate({ texts: ['hello'], targetLanguage: 'ko' })).toBeNull();
  });

  it('states what each local provider sends off-device: nothing', async () => {
    for (const provider of [
      new LocalHeuristicVisionProvider(),
      new LocalSoundEventProvider(),
      new RegionOnlyOcrProvider(),
    ]) {
      expect(provider.info.kind).toBe('local');
      expect(provider.info.dataLeavingDevice.toLowerCase()).toContain('nothing');
    }
  });
});
