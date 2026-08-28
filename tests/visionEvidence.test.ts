/**
 * Vision output → evidence → action beats.
 *
 * The point of these tests is the boundary, not the model: a provider's
 * response is untrusted input, it is validated before it can become evidence,
 * everything it contributes is marked inferred, and it can never place an
 * observation outside the window it was shown.
 */

import { describe, expect, it } from 'vitest';
import {
  buildScreenplay,
  validateVisionAnalysis,
  visionAnalysisToEvidence,
  type EvidenceEvent,
  type VisionWindowAnalysis,
} from '@/core';

const analysis: VisionWindowAnalysis = {
  actions: [
    {
      offsetMs: 200,
      description: 'A woman opens the refrigerator',
      participants: [],
      confidence: 'medium',
    },
    {
      offsetMs: 1_400,
      description: 'She pauses, then closes it',
      participants: [],
      confidence: 'low',
    },
  ],
  characters: [{ label: 'woman in a grey coat', present: true }],
  settingChanges: [
    {
      description: 'a small kitchen',
      interiorExterior: 'INT',
      timeOfDay: 'NIGHT',
      confidence: 'medium',
    },
  ],
  text: [{ text: 'CLOSED', offsetMs: 900 }],
  uncertainties: ['cannot tell what is inside'],
};

describe('vision analysis mapping', () => {
  it('places actions inside the window at their reported offsets', () => {
    const events = visionAnalysisToEvidence(analysis, { start: 10_000, end: 12_400 });
    const actions = events.filter(
      (event) => event.source === 'video' && event.payload.kind === 'action',
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]!.start).toBe(10_200);
    expect(actions[1]!.start).toBe(11_400);
  });

  it('clamps an offset that runs past the end of the window it was given', () => {
    const events = visionAnalysisToEvidence(
      {
        ...analysis,
        actions: [
          {
            offsetMs: 999_999,
            description: 'Something later',
            participants: [],
            confidence: 'low',
          },
        ],
      },
      { start: 1_000, end: 3_000 },
    );
    expect(events[0]!.start).toBe(3_000);
  });

  it('marks everything a model contributed as inferred', () => {
    const events = visionAnalysisToEvidence(analysis, { start: 0, end: 2_000 });
    const visual = events.filter((event) => event.source === 'video');
    expect(visual.length).toBeGreaterThan(0);
    for (const event of visual) {
      expect(event.source === 'video' && event.payload.inferred).toBe(true);
    }
  });

  it('turns a setting observation into setting evidence, not a scene heading', () => {
    const events = visionAnalysisToEvidence(analysis, { start: 0, end: 2_000 });
    const setting = events.find(
      (event) => event.source === 'video' && event.payload.kind === 'setting',
    );
    expect(setting).toBeDefined();
    expect(setting!.source === 'video' && setting!.payload.description).toBe(
      'INT a small kitchen NIGHT',
    );
  });

  it('reads on-screen text into OCR evidence', () => {
    const events = visionAnalysisToEvidence(analysis, { start: 0, end: 2_000 });
    const ocr = events.find((event) => event.source === 'ocr');
    expect(ocr?.source === 'ocr' && ocr.payload.text).toBe('CLOSED');
  });

  it('drops empty descriptions rather than emitting a blank beat', () => {
    const events = visionAnalysisToEvidence(
      {
        ...analysis,
        actions: [{ offsetMs: 0, description: '   ', participants: [], confidence: 'high' }],
        settingChanges: [],
        text: [],
      },
      { start: 0, end: 1_000 },
    );
    expect(events).toHaveLength(0);
  });
});

describe('vision response validation', () => {
  it('rejects a response whose shape is wrong', () => {
    expect(validateVisionAnalysis({ actions: 'lots of them' })).toBeNull();
    expect(validateVisionAnalysis(null)).toBeNull();
    expect(validateVisionAnalysis('{"actions":[]}')).toBeNull();
  });

  it('accepts a sparse response and fills honest defaults', () => {
    const value = validateVisionAnalysis({ actions: [] });
    expect(value).toEqual({
      actions: [],
      characters: [],
      settingChanges: [],
      text: [],
      uncertainties: [],
    });
  });

  it('bounds an over-long description instead of taking it whole', () => {
    const value = validateVisionAnalysis({
      actions: [{ offsetMs: 0, description: 'x'.repeat(5_000) }],
    });
    expect(value!.actions[0]!.description.length).toBeLessThanOrEqual(400);
  });
});

describe('vision evidence becomes action beats', () => {
  it('writes an action line the local scanner could not have written', () => {
    const events: EvidenceEvent[] = [
      // A local scene cut, which alone produces only a transition.
      {
        id: 'cut-1',
        source: 'video',
        start: 10_000,
        confidence: 'high',
        provisional: false,
        payload: { kind: 'scene-change', metrics: { sceneCutScore: 0.8 } },
      },
      ...visionAnalysisToEvidence(analysis, { start: 10_000, end: 12_400 }),
    ];

    const result = buildScreenplay(events, { durationMs: 15_000 });
    const beats = result.scenes.flatMap((scene) => scene.beats);
    const actions = beats.filter((beat) => beat.type === 'action');

    // Only the medium-confidence action. A low-confidence inference is held
    // back unless the reader explicitly asks for uncertain material.
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type === 'action' && actions[0]!.description).toMatch(/refrigerator/i);

    const permissive = buildScreenplay(events, { durationMs: 15_000, includeLowConfidence: true });
    expect(
      permissive.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'action'),
    ).toHaveLength(2);

    // The setting becomes the scene heading, not a third action line repeating
    // the location inside the scene it already labels.
    expect(result.scenes[0]!.setting?.description).toBe('a small kitchen');
    expect(result.scenes[0]!.setting?.interiorExterior).toBe('INT');
    expect(result.scenes[0]!.setting?.timeOfDay).toBe('NIGHT');
    expect(
      actions.some((beat) => beat.type === 'action' && /kitchen/i.test(beat.description)),
    ).toBe(false);
    // Provenance keeps the distinction between measured and modelled.
    expect(actions[0]!.provenance.inferred).toBe(true);
    expect(actions[0]!.provenance.sources).toContain('video');
  });

  it('still writes no action text when only local motion evidence exists', () => {
    const result = buildScreenplay(
      [
        {
          id: 'motion-1',
          source: 'video',
          start: 1_000,
          end: 3_000,
          confidence: 'medium',
          provisional: false,
          payload: { kind: 'action', metrics: { motionScore: 0.7 } },
        },
      ],
      { durationMs: 5_000 },
    );
    expect(result.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'action')).toHaveLength(
      0,
    );
  });
});
