import { describe, expect, it } from 'vitest';
import { fuseWindow } from '@/scenes/fusion';
import { buildEvidenceWindows } from '@/evidence/windows';
import { CharacterRegistry, characterCueName } from '@/characters/entities';
import { attributeSpeaker } from '@/characters/attribution';
import {
  collectBoundarySignals,
  detectSceneBoundaries,
  scoreBoundaryCandidates,
  selectBoundaries,
} from '@/scenes/boundaries';
import { SceneBuilder } from '@/scenes/builder';
import { EvidenceTimeline } from '@/evidence/timeline';
import { createIdFactory } from '@/utils/id';
import type {
  EvidenceEvent,
  OcrEvidence,
  SilenceEvidence,
  SoundEvidence,
  SpeakerEvidence,
  SpeechEvidence,
  SubtitleEvidence,
  VisualEvidence,
} from '@/evidence/types';

let counter = 0;
const id = () => `f${++counter}`;

const subtitle = (
  start: number,
  end: number,
  text: string,
  extra: Partial<SubtitleEvidence['payload']> = {},
): SubtitleEvidence => ({
  id: id(),
  source: 'subtitle',
  start,
  end,
  confidence: 'high',
  provisional: false,
  payload: { text, language: 'en', ...extra },
});

const speech = (start: number, end: number, text: string, speakerId?: string): SpeechEvidence => ({
  id: id(),
  source: 'audio-asr',
  start,
  end,
  confidence: 'medium',
  provisional: false,
  payload: { text, language: 'en', ...(speakerId ? { speakerId } : {}) },
});

const speaker = (start: number, end: number, speakerId: string): SpeakerEvidence => ({
  id: id(),
  source: 'audio-speaker',
  start,
  end,
  confidence: 'high',
  provisional: false,
  payload: { speakerId },
});

const sound = (start: number, kind: SoundEvidence['payload']['kind']): SoundEvidence => ({
  id: id(),
  source: 'audio-event',
  start,
  end: start + 200,
  confidence: 'low',
  provisional: false,
  payload: { kind },
});

const action = (start: number, end: number, description?: string): VisualEvidence => ({
  id: id(),
  source: 'video',
  start,
  end,
  confidence: 'medium',
  provisional: false,
  payload: {
    kind: 'action',
    ...(description ? { description, inferred: true } : {}),
    metrics: { motionScore: 0.4 },
  },
});

const cut = (start: number): VisualEvidence => ({
  id: id(),
  source: 'video',
  start,
  confidence: 'high',
  provisional: false,
  payload: { kind: 'scene-change', metrics: { sceneCutScore: 0.9 } },
});

const ocr = (start: number, text: string, unrecognized = false): OcrEvidence => ({
  id: id(),
  source: 'ocr',
  start,
  confidence: 'medium',
  provisional: false,
  payload: { text, ...(unrecognized ? { unrecognized: true } : {}) },
});

/** Fuses one window over the given events. */
function fuse(events: EvidenceEvent[], options: Parameters<typeof fuseWindow>[1] = { registry: new CharacterRegistry() }) {
  const [window] = buildEvidenceWindows(events, { start: 0, end: 30_000 });
  if (!window) throw new Error('no window built');
  return fuseWindow(window, { idFactory: createIdFactory('b'), ...options });
}

describe('dialogue fusion', () => {
  it('produces one beat when subtitle and ASR agree', () => {
    const result = fuse([subtitle(1000, 3000, 'Where are you?'), speech(1100, 2900, 'where are you')]);
    const dialogue = result.beats.filter((b) => b.type === 'dialogue');
    expect(dialogue).toHaveLength(1);
    // Two independent sources agreeing raises confidence.
    expect(dialogue[0]!.provenance.sources).toContain('subtitle');
    expect(dialogue[0]!.provenance.sources).toContain('audio-asr');
    expect(dialogue[0]!.provenance.confidence).toBe('high');
  });

  it('refines onset timing from the audio when the subtitle leads the line', () => {
    // Subtitles are routinely displayed a beat before the line is spoken.
    const result = fuse([subtitle(1000, 3000, 'Where are you?'), speech(1400, 2900, 'where are you')]);
    const dialogue = result.beats.find((b) => b.type === 'dialogue');
    expect(dialogue!.start).toBe(1400);
  });

  it('recovers a line the subtitle track omitted', () => {
    const result = fuse([
      subtitle(1000, 2000, 'First line'),
      speech(4000, 5000, 'A line the captions missed'),
    ]);
    const dialogue = result.beats.filter((b) => b.type === 'dialogue');
    expect(dialogue).toHaveLength(2);
    const recovered = dialogue.find((b) => b.start === 4000)!;
    expect(Object.values(recovered.textVariants)[0]!.origin).toBe('audio-asr');
  });

  it('records a conflict rather than silently choosing when sources disagree', () => {
    const result = fuse([
      subtitle(1000, 3000, 'I am staying here tonight'),
      speech(1000, 3000, 'completely different words entirely'),
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.description).toContain('differs');
    // The subtitle still stands; the ASR text is not silently substituted.
    const dialogue = result.beats.filter((b) => b.type === 'dialogue');
    expect(dialogue).toHaveLength(1);
    expect(Object.values(dialogue[0]!.textVariants)[0]!.text).toBe('I am staying here tonight');
  });

  it('merges the same line across languages into one beat with two variants', () => {
    const result = fuse([
      subtitle(1000, 3000, "We're out of milk.", { language: 'en' }),
      subtitle(1000, 3000, '우유가 없네.', { language: 'ko' }),
    ]);
    const dialogue = result.beats.filter((b) => b.type === 'dialogue');
    expect(dialogue).toHaveLength(1);
    expect(Object.keys(dialogue[0]!.textVariants).sort()).toEqual(['en', 'ko']);
    // Both are genuine platform subtitles, and both say so.
    expect(dialogue[0]!.textVariants.en!.origin).toBe('platform-subtitle');
    expect(dialogue[0]!.textVariants.ko!.origin).toBe('platform-subtitle');
  });

  it('keeps two same-language cues at the same moment as separate lines', () => {
    // Overlapping speakers, not one line in two languages.
    const result = fuse([subtitle(1000, 3000, 'Get out!'), subtitle(1100, 3000, 'No!')]);
    expect(result.beats.filter((b) => b.type === 'dialogue')).toHaveLength(2);
  });

  it('marks auto-generated caption tracks as less certain than authored ones', () => {
    const authored = fuse([subtitle(1000, 2000, 'Hello')]);
    const generated = fuse([subtitle(1000, 2000, 'Hello', { autoGenerated: true })]);
    const a = authored.beats.find((b) => b.type === 'dialogue')!;
    const g = generated.beats.find((b) => b.type === 'dialogue')!;
    expect(a.textVariants.en!.confidence).toBe('high');
    expect(g.textVariants.en!.confidence).toBe('medium');
  });

  it('attributes a line to a diarized voice cluster when no label exists', () => {
    const registry = new CharacterRegistry();
    const result = fuse(
      [subtitle(1000, 3000, 'Where are you?'), speaker(950, 3050, 'speaker-002')],
      { registry },
    );
    const beat = result.beats.find((b) => b.type === 'dialogue')!;
    expect(beat.attributionMethod).toBe('diarization');
    expect(registry.get(beat.characterId!)?.speakerIds).toContain('speaker-002');
  });

  it('strips a speaker label out of the dialogue text', () => {
    const registry = new CharacterRegistry();
    const result = fuse([subtitle(1000, 3000, 'JANE: Where are you?')], { registry });
    const dialogue = result.beats.find((b) => b.type === 'dialogue')!;
    expect(dialogue.textVariants.en!.text).toBe('Where are you?');
    expect(registry.findByName('JANE')).toBeDefined();
    expect(dialogue.attributionMethod).toBe('subtitle-label');
  });
});

describe('dialogue and action stay separate', () => {
  it('never derives an action from what a character said', () => {
    // The central discipline: dialogue says she is leaving, the picture shows
    // nothing. No "she stands and leaves" may appear.
    const result = fuse([subtitle(1000, 3000, "I'm leaving.")]);
    const actions = result.beats.filter((b) => b.type === 'action');
    expect(actions).toHaveLength(0);
  });

  it('emits an action only when visual evidence carries a description', () => {
    const withDescription = fuse([action(1000, 2000, 'She stands and crosses to the door')]);
    expect(withDescription.beats.filter((b) => b.type === 'action')).toHaveLength(1);

    // A motion measurement with no description is not a sentence.
    const withoutDescription = fuse([action(1000, 2000)]);
    expect(withoutDescription.beats.filter((b) => b.type === 'action')).toHaveLength(0);
  });

  it('emits action from the picture with no dialogue present at all', () => {
    const result = fuse([action(1000, 2000, 'A car pulls up outside')]);
    const actions = result.beats.filter((b) => b.type === 'action');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.provenance.inferred).toBe(true);
  });
});

describe('sound and silence fusion', () => {
  it('prefers an authored bracketed caption over the acoustic classifier', () => {
    const result = fuse([subtitle(1000, 2000, '[door slams]'), sound(1100, 'impact')]);
    const sounds = result.beats.filter((b) => b.type === 'sound');
    expect(sounds).toHaveLength(1);
    expect(sounds[0]!.description).toBe('Door slams.');
    // The caption is not dialogue.
    expect(result.beats.filter((b) => b.type === 'dialogue')).toHaveLength(0);
  });

  it('emits a sound beat with no dialogue anywhere near it', () => {
    const result = fuse([sound(1000, 'impact')]);
    const sounds = result.beats.filter((b) => b.type === 'sound');
    expect(sounds).toHaveLength(1);
    expect(sounds[0]!.description).toBe('A sharp impact.');
  });

  it('hides unclassified low-confidence sounds unless asked for them', () => {
    const events = [
      {
        ...sound(1000, 'unclassified'),
        confidence: 'unknown' as const,
      },
    ];
    expect(fuse(events).beats.filter((b) => b.type === 'sound')).toHaveLength(0);
    expect(
      fuse(events, { registry: new CharacterRegistry(), includeLowConfidence: true }).beats.filter(
        (b) => b.type === 'sound',
      ),
    ).toHaveLength(1);
  });

  it('reports only significant silences', () => {
    const significant: SilenceEvidence = {
      id: id(),
      source: 'audio-silence',
      start: 1000,
      end: 6000,
      confidence: 'medium',
      provisional: false,
      payload: { durationMs: 5000, significant: true },
    };
    const trivial: SilenceEvidence = { ...significant, id: id(), start: 8000, end: 9000, payload: { durationMs: 1000, significant: false } };

    const result = fuse([significant, trivial]);
    const silences = result.beats.filter((b) => b.type === 'sound' && b.description.includes('ilence'));
    expect(silences).toHaveLength(1);
  });
});

describe('on-screen text fusion', () => {
  it('emits recognized text as a beat', () => {
    const result = fuse([ocr(1000, '3 DAYS EARLIER')]);
    const beats = result.beats.filter((b) => b.type === 'on-screen-text');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.type === 'on-screen-text' && beats[0]!.text).toBe('3 DAYS EARLIER');
  });

  it('never invents words for a text region it could not read', () => {
    const result = fuse([ocr(1000, '', true)]);
    expect(result.beats.filter((b) => b.type === 'on-screen-text')).toHaveLength(0);
  });
});

describe('transitions', () => {
  it('emits a transition only where a cut was actually detected', () => {
    const result = fuse([cut(2000), subtitle(3000, 4000, 'After the cut')]);
    const transitions = result.beats.filter((b) => b.type === 'transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.start).toBe(2000);
  });
});

describe('speaker attribution priority', () => {
  it('prefers a subtitle label over diarization', () => {
    const registry = new CharacterRegistry();
    const result = attributeSpeaker(
      {
        start: 1000,
        end: 2000,
        subtitleSpeakerLabel: 'JANE',
        speakerCandidates: [{ speakerId: 'speaker-002', start: 1000, end: 2000, confidence: 'high' }],
      },
      registry,
    );
    expect(result.method).toBe('subtitle-label');
    expect(registry.get(result.characterId!)?.displayName).toBe('JANE');
  });

  it('prefers a user correction over diarization', () => {
    const registry = new CharacterRegistry();
    const character = registry.ensureForName('DANIEL', 0, 'user');
    const result = attributeSpeaker(
      {
        start: 1000,
        end: 2000,
        userCharacterId: character.id,
        speakerCandidates: [{ speakerId: 'speaker-002', start: 1000, end: 2000, confidence: 'high' }],
      },
      registry,
    );
    expect(result.method).toBe('user-correction');
    expect(result.characterId).toBe(character.id);
  });

  it('falls back to diarization with reduced confidence', () => {
    const registry = new CharacterRegistry();
    const result = attributeSpeaker(
      {
        start: 1000,
        end: 2000,
        speakerCandidates: [{ speakerId: 'speaker-001', start: 900, end: 2100, confidence: 'high' }],
      },
      registry,
    );
    expect(result.method).toBe('diarization');
    // One weak source is never high confidence on its own.
    expect(result.confidence).toBe('medium');
  });

  it('uses alternation only in a two-hander', () => {
    const registry = new CharacterRegistry();
    const a = registry.ensureForName('A', 0);
    const b = registry.ensureForName('B', 0);

    const twoHander = attributeSpeaker(
      { start: 1000, end: 2000, previousCharacterId: a.id, presentCharacterIds: [a.id, b.id] },
      registry,
    );
    expect(twoHander.method).toBe('dialogue-context');
    expect(twoHander.characterId).toBe(b.id);

    // In a crowd, alternation is guesswork.
    const c = registry.ensureForName('C', 0);
    const crowd = attributeSpeaker(
      { start: 1000, end: 2000, previousCharacterId: a.id, presentCharacterIds: [a.id, b.id, c.id] },
      registry,
    );
    expect(crowd.method).toBe('unknown');
  });

  it('returns unknown rather than guessing when there is no evidence', () => {
    const result = attributeSpeaker({ start: 1000, end: 2000 }, new CharacterRegistry());
    expect(result.method).toBe('unknown');
    expect(result.characterId).toBeUndefined();
  });
});

describe('character registry', () => {
  it('labels unnamed speakers anonymously', () => {
    const registry = new CharacterRegistry();
    const character = registry.ensureForSpeaker('speaker-002', 0);
    expect(characterCueName(character)).toBe('SPEAKER 2');
  });

  it('lets the user rename, and keeps the old name as an alias', () => {
    const registry = new CharacterRegistry();
    const character = registry.ensureForName('MAN', 0);
    registry.rename(character.id, 'Daniel');
    expect(registry.get(character.id)?.displayName).toBe('DANIEL');
    expect(registry.get(character.id)?.aliases).toContain('MAN');
    expect(registry.get(character.id)?.source).toBe('user');
  });

  it('merges two clusters the user recognises as one person', () => {
    const registry = new CharacterRegistry();
    const a = registry.ensureForSpeaker('speaker-001', 0);
    const b = registry.ensureForSpeaker('speaker-002', 1000);
    registry.merge(a.id, b.id);

    expect(registry.size).toBe(1);
    expect(registry.get(a.id)!.speakerIds.sort()).toEqual(['speaker-001', 'speaker-002']);
    expect(registry.findBySpeakerId('speaker-002')?.id).toBe(a.id);
  });

  it('splits a cluster the user recognises as two people', () => {
    const registry = new CharacterRegistry();
    const character = registry.ensureForSpeaker('speaker-001', 0);
    registry.linkSpeaker(character.id, 'speaker-002');

    const created = registry.split(character.id, 'speaker-002', 5000);
    expect(created).toBeDefined();
    expect(created!.id).not.toBe(character.id);
    expect(registry.get(character.id)!.speakerIds).toEqual(['speaker-001']);
  });

  it('round-trips through a snapshot', () => {
    const registry = new CharacterRegistry();
    const character = registry.ensureForName('JANE', 0);
    registry.linkSpeaker(character.id, 'speaker-003');

    const restored = new CharacterRegistry();
    restored.restore(registry.snapshot());
    expect(restored.findByName('JANE')?.id).toBe(character.id);
    expect(restored.findBySpeakerId('speaker-003')?.id).toBe(character.id);
  });
});

describe('scene boundaries', () => {
  it('does not break a scene on a single shot change', () => {
    // A conversation cutting between two angles is one scene.
    const events = [cut(5000), subtitle(6000, 7000, 'Still the same scene')];
    const candidates = scoreBoundaryCandidates(collectBoundarySignals(events));
    expect(candidates[0]!.score).toBeLessThan(0.55);
    expect(selectBoundaries(candidates)).toHaveLength(0);
  });

  it('breaks when several independent signals agree', () => {
    const events: EvidenceEvent[] = [
      cut(10_000),
      {
        id: id(),
        source: 'video',
        start: 10_000,
        confidence: 'medium',
        provisional: false,
        payload: { kind: 'setting', description: 'INT. KITCHEN - DAY' },
      } as VisualEvidence,
      {
        id: id(),
        source: 'audio-silence',
        start: 8_000,
        end: 10_000,
        confidence: 'medium',
        provisional: false,
        payload: { durationMs: 8_000, significant: true },
      } as SilenceEvidence,
    ];
    const boundaries = detectSceneBoundaries(events);
    expect(boundaries).toHaveLength(1);
    // The visual cut is the true boundary instant.
    expect(boundaries[0]!.timestamp).toBe(10_000);
  });

  it('treats a chapter marker as near-decisive on its own', () => {
    const events: EvidenceEvent[] = [
      {
        id: id(),
        source: 'metadata',
        start: 30_000,
        confidence: 'high',
        provisional: false,
        payload: { kind: 'chapter', value: 'Chapter 2' },
      },
    ];
    expect(detectSceneBoundaries(events)).toHaveLength(1);
  });

  it('suppresses boundaries closer together than the minimum scene length', () => {
    const events: EvidenceEvent[] = [10_000, 11_000, 12_000].map((t) => ({
      id: id(),
      source: 'metadata',
      start: t,
      confidence: 'high',
      provisional: false,
      payload: { kind: 'chapter', value: `Chapter ${t}` },
    }));
    expect(detectSceneBoundaries(events).length).toBeLessThanOrEqual(1);
  });

  it('gives a multi-signal boundary better confidence than a single-signal one', () => {
    const single = scoreBoundaryCandidates([{ kind: 'visual-cut', timestamp: 0, strength: 1 }]);
    const multi = scoreBoundaryCandidates([
      { kind: 'visual-cut', timestamp: 0, strength: 1 },
      { kind: 'location-change', timestamp: 100, strength: 1 },
      { kind: 'long-silence', timestamp: 200, strength: 1 },
    ]);
    expect(multi[0]!.score).toBeGreaterThan(single[0]!.score);
  });
});

describe('rolling scene builder', () => {
  function buildTimeline(events: EvidenceEvent[], durationMs = 120_000) {
    const timeline = new EvidenceTimeline();
    timeline.setDuration(durationMs);
    timeline.appendAll(events);
    return timeline;
  }

  it('produces scenes with beats from mixed evidence', () => {
    const registry = new CharacterRegistry();
    const builder = new SceneBuilder({ registry });
    const timeline = buildTimeline([
      subtitle(1000, 3000, 'CARMY: Where is Richie?'),
      action(3500, 4500, 'Sydney looks toward the door'),
      subtitle(5000, 6000, 'SYDNEY: Outside.'),
    ]);

    const result = builder.rebuild(timeline, 10_000);
    expect(result.scenes.length).toBeGreaterThanOrEqual(1);
    const beats = result.scenes.flatMap((s) => s.beats);
    expect(beats.filter((b) => b.type === 'dialogue')).toHaveLength(2);
    expect(beats.filter((b) => b.type === 'action')).toHaveLength(1);
  });

  it('gives beats stable ids across rebuilds so the panel does not flicker', () => {
    const builder = new SceneBuilder({ registry: new CharacterRegistry() });
    const timeline = buildTimeline([subtitle(1000, 3000, 'Stable line')]);

    const first = builder.rebuild(timeline, 5_000).scenes.flatMap((s) => s.beats).map((b) => b.id);
    const second = builder.rebuild(timeline, 6_000).scenes.flatMap((s) => s.beats).map((b) => b.id);
    expect(second).toEqual(first);
  });

  it('does not duplicate scenes when the viewer rewinds and replays', () => {
    const builder = new SceneBuilder({ registry: new CharacterRegistry() });
    const timeline = buildTimeline([subtitle(1000, 3000, 'Replayed line')]);

    builder.rebuild(timeline, 10_000);
    builder.handleSeek(0);
    // Re-observing produces the same evidence, which the timeline deduplicates.
    timeline.append(subtitle(1000, 3000, 'Replayed line'));
    const result = builder.rebuild(timeline, 10_000);

    const dialogue = result.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'dialogue');
    expect(dialogue).toHaveLength(1);
  });

  it('finalizes scenes once playback has moved safely past them', () => {
    const builder = new SceneBuilder({ registry: new CharacterRegistry(), stabilizationMs: 5_000 });
    const timeline = buildTimeline([subtitle(1000, 3000, 'Early line')]);

    expect(builder.rebuild(timeline, 4_000).newlyFinalized).toHaveLength(0);
    const later = builder.rebuild(timeline, 60_000);
    expect(later.scenes.some((s) => s.status === 'finalized')).toBe(true);
  });

  it('invents nothing for a range that was skipped', () => {
    const builder = new SceneBuilder({ registry: new CharacterRegistry() });
    const timeline = buildTimeline([subtitle(1000, 3000, 'Before the jump'), subtitle(600_000, 602_000, 'After the jump')], 700_000);
    timeline.markObserved(1000, 3000);
    timeline.markObserved(600_000, 602_000);

    const result = builder.rebuild(timeline, 605_000);
    const beats = result.scenes.flatMap((s) => s.beats);
    // Exactly two lines: nothing was manufactured for the ten skipped minutes.
    expect(beats.filter((b) => b.type === 'dialogue')).toHaveLength(2);
    expect(timeline.uncoveredRanges().length).toBeGreaterThan(0);
  });

  it('restores previously saved scenes', () => {
    const builder = new SceneBuilder({ registry: new CharacterRegistry() });
    const timeline = buildTimeline([subtitle(1000, 3000, 'Saved line')]);
    builder.rebuild(timeline, 60_000);
    const saved = builder.scenes;

    const reopened = new SceneBuilder({ registry: new CharacterRegistry() });
    reopened.restore(saved);
    expect(reopened.scenes).toHaveLength(saved.length);
  });
});
