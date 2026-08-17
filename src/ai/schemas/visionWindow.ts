/**
 * Schema and prompt for temporal vision-window analysis.
 *
 * The prompt is as important as the schema: it tells the provider that the
 * frames are an ordered sequence, that it must describe *progression*, and that
 * it must not invent character names, motives, or anything it cannot see. The
 * validator then enforces the shape, and anything that fails is discarded.
 */

import { v, type Validator } from '../validation';
import type { VisionWindowAnalysis, VisionWindowRequest } from '../types';

const confidence = v.literalUnion(['high', 'medium', 'low', 'unknown'] as const);

const actionValidator = v.object(
  {
    offsetMs: v.number({ min: 0, max: 600_000 }),
    description: v.string({ min: 1, max: 400 }),
    participants: v.array(v.string({ max: 80 }), { max: 8, skipInvalid: true }),
    confidence,
  },
  ['participants', 'confidence'],
);

const characterValidator = v.object(
  {
    label: v.string({ min: 1, max: 120 }),
    present: v.boolean(),
    enters: v.boolean(),
    exits: v.boolean(),
    expression: v.string({ max: 120 }),
  },
  ['enters', 'exits', 'expression'],
);

const settingValidator = v.object(
  {
    description: v.string({ min: 1, max: 200 }),
    interiorExterior: v.literalUnion(['INT', 'EXT', 'UNKNOWN'] as const),
    timeOfDay: v.string({ max: 60 }),
    confidence,
  },
  ['interiorExterior', 'timeOfDay', 'confidence'],
);

const textValidator = v.object({
  text: v.string({ min: 1, max: 300 }),
  offsetMs: v.number({ min: 0, max: 600_000 }),
});

const analysisValidator = v.object(
  {
    actions: v.array(actionValidator, { max: 12, skipInvalid: true }),
    characters: v.array(characterValidator, { max: 10, skipInvalid: true }),
    settingChanges: v.array(settingValidator, { max: 4, skipInvalid: true }),
    text: v.array(textValidator, { max: 8, skipInvalid: true }),
    uncertainties: v.array(v.string({ max: 200 }), { max: 6, skipInvalid: true }),
  },
  ['actions', 'characters', 'settingChanges', 'text', 'uncertainties'],
);

/**
 * Validates and normalizes a provider response.
 *
 * Missing arrays become empty arrays and missing confidences become `unknown` —
 * both are honest defaults. What it will not do is fabricate content.
 */
export function validateVisionAnalysis(value: unknown): VisionWindowAnalysis | null {
  const result = analysisValidator.validate(value);
  if (!result.ok) return null;
  const raw = result.value;
  return {
    actions: (raw.actions ?? []).map((a) => ({
      offsetMs: a.offsetMs,
      description: a.description,
      participants: a.participants ?? [],
      confidence: a.confidence ?? 'unknown',
    })),
    characters: (raw.characters ?? []).map((c) => ({
      label: c.label,
      present: c.present,
      ...(c.enters === undefined ? {} : { enters: c.enters }),
      ...(c.exits === undefined ? {} : { exits: c.exits }),
      ...(c.expression === undefined ? {} : { expression: c.expression }),
    })),
    settingChanges: (raw.settingChanges ?? []).map((s) => ({
      description: s.description,
      ...(s.interiorExterior === undefined ? {} : { interiorExterior: s.interiorExterior }),
      ...(s.timeOfDay === undefined ? {} : { timeOfDay: s.timeOfDay }),
      confidence: s.confidence ?? 'unknown',
    })),
    text: raw.text ?? [],
    uncertainties: raw.uncertainties ?? [],
  };
}

export const VISION_ANALYSIS_VALIDATOR: Validator<unknown> = analysisValidator as Validator<unknown>;

/** JSON Schema handed to providers that support tool/structured output. */
export const VISION_ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  required: ['actions', 'characters', 'settingChanges', 'text', 'uncertainties'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['offsetMs', 'description'],
        properties: {
          offsetMs: { type: 'number', description: 'Milliseconds after the window start.' },
          description: {
            type: 'string',
            description: 'One observable action, present tense, screenplay style.',
          },
          participants: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
        },
      },
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'present'],
        properties: {
          label: { type: 'string', description: 'Descriptive label only, never a real person’s name.' },
          present: { type: 'boolean' },
          enters: { type: 'boolean' },
          exits: { type: 'boolean' },
          expression: { type: 'string' },
        },
      },
    },
    settingChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string' },
          interiorExterior: { type: 'string', enum: ['INT', 'EXT', 'UNKNOWN'] },
          timeOfDay: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
        },
      },
    },
    text: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'offsetMs'],
        properties: { text: { type: 'string' }, offsetMs: { type: 'number' } },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const VISION_SYSTEM_PROMPT = `You are a film-observation assistant for a screenplay reconstruction tool.

You receive an ORDERED SEQUENCE of frames sampled from one short window of a video, with the milliseconds offset of each frame, plus the dialogue and sound events that occurred in the same window.

Your job is to describe what is OBSERVABLE, and how it PROGRESSES across the sequence.

Rules:
- Treat the frames as a continuous action, not as unrelated photographs. Describe progression ("reaches for the handle, hesitates, then opens it"), not a caption per frame.
- Report only what is visible. Never infer motives, backstory, relationships, or off-screen facts.
- Never state a real person's or actor's name. Refer to people by neutral descriptive labels ("the man in the blue coat") or by a label supplied in knownCharacters.
- If the frames are black, corrupted, or unreadable, return empty arrays and say so in uncertainties.
- Use offsetMs to place each action within the window so ordering is preserved.
- Group micro-movements into one screenplay-relevant action. Do not emit one entry per limb movement.
- Preserve a hesitation, flinch, or reversal when it is clearly visible — those are meaningful.
- Present tense, third person, plain declarative sentences.
- Respond with JSON only, matching the provided schema. No prose outside the JSON.`;

/** Builds the user-turn text describing one window. */
export function buildVisionUserPrompt(request: VisionWindowRequest): string {
  const lines: string[] = [];
  lines.push(`WINDOW: ${request.start}ms - ${request.end}ms (${request.end - request.start}ms)`);
  lines.push(`FRAME COUNT: ${request.frames.length}`);
  lines.push(
    `FRAME OFFSETS (ms after window start): ${request.frames
      .map((f) => f.timestamp - request.start)
      .join(', ')}`,
  );

  if (request.currentSetting) lines.push(`ESTABLISHED SETTING: ${request.currentSetting}`);

  if (request.knownCharacters.length > 0) {
    lines.push(
      `KNOWN CHARACTER LABELS: ${request.knownCharacters
        .map((c) => c.displayName ?? c.id)
        .join(', ')}`,
    );
  }

  if (request.dialogue.length > 0) {
    lines.push('DIALOGUE IN THIS WINDOW:');
    for (const d of request.dialogue) {
      lines.push(`  +${d.start - request.start}ms ${d.speakerId ?? 'unknown speaker'}: ${d.text}`);
    }
  } else {
    lines.push('DIALOGUE IN THIS WINDOW: none');
  }

  if (request.soundEvents.length > 0) {
    lines.push('SOUND EVENTS IN THIS WINDOW:');
    for (const s of request.soundEvents) {
      lines.push(`  +${s.start - request.start}ms ${s.description ?? s.kind}`);
    }
  }

  if (request.metrics) {
    // Telling the model where the local scanner measured change focuses it on
    // the part of the frame that actually moved.
    lines.push(
      `LOCAL CHANGE METRICS: motion=${fmt(request.metrics.motionScore)} cut=${fmt(
        request.metrics.sceneCutScore,
      )} textRegion=${fmt(request.metrics.textChangeScore)} centreRegion=${fmt(
        request.metrics.faceChangeScore,
      )}`,
    );
  }

  if (request.requestOcr) {
    lines.push('TASK ADDITION: read any superimposed on-screen text (titles, cards, signs) into "text".');
  }

  lines.push(
    'TASK: describe the observable action progression, who is present, any entrance or exit, any visible change of expression, any change of setting, and anything you cannot determine.',
  );
  return lines.join('\n');
}

function fmt(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(3);
}
