import { describe, expect, it } from 'vitest';
import {
  buildVisionUserPrompt,
  VISION_ANALYSIS_JSON_SCHEMA,
  VISION_SYSTEM_PROMPT,
} from '@/ai/schemas/visionWindow';

const frame = (timestamp: number) => ({
  timestamp,
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'image/jpeg',
  width: 480,
  height: 270,
});

describe('vision action-density guardrails', () => {
  it('defines an action as a meaningful state change rather than persistence', () => {
    expect(VISION_SYSTEM_PROMPT).toContain('meaningful visible state change');
    expect(VISION_SYSTEM_PROMPT).toContain('emit at most one action');
    expect(VISION_SYSTEM_PROMPT).toContain('return zero actions rather than padding the list');
  });

  it('explicitly forbids the repeated static-state wording seen in production output', () => {
    for (const word of ['maintains', 'continues', 'remains']) {
      expect(VISION_SYSTEM_PROMPT).toContain(`"${word}"`);
    }
  });

  it('describes schema actions as meaningful observable state changes', () => {
    const schema = VISION_ANALYSIS_JSON_SCHEMA.properties.actions.items.properties.description;
    expect(schema.description).toContain('meaningful observable state change');
  });

  it('repeats the anti-padding constraint in the per-window task instruction', () => {
    const prompt = buildVisionUserPrompt({
      start: 10_000,
      end: 11_000,
      frames: [frame(10_000), frame(10_500), frame(11_000)],
      dialogue: [],
      soundEvents: [],
      knownCharacters: [],
    });

    expect(prompt).toContain('Do not create repeated action entries');
  });
});
