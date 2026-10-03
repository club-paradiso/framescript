import { describe, expect, it } from 'vitest';
import {
  DIALOGUE_LEAD_IN_MS,
  RecentWindowContext,
  dialogueInWindow,
  soundsInWindow,
} from '../src/ai/windowContext';
import type { EvidenceEvent } from '../src/evidence/types';

let id = 0;
const base = { provisional: false, confidence: 'high' as const };

function subtitle(start: number, end: number, text: string, extra: object = {}): EvidenceEvent {
  return {
    ...base,
    id: `s${id++}`,
    source: 'subtitle',
    start,
    end,
    payload: { text, language: 'en', ...extra },
  } as EvidenceEvent;
}

function speech(start: number, end: number, text: string, speakerId?: string): EvidenceEvent {
  return {
    ...base,
    id: `a${id++}`,
    source: 'audio-asr',
    start,
    end,
    payload: { text, ...(speakerId ? { speakerId } : {}) },
  } as EvidenceEvent;
}

function sound(start: number, kind = 'impact'): EvidenceEvent {
  return {
    ...base,
    id: `e${id++}`,
    source: 'audio-event',
    start,
    payload: { kind },
  } as EvidenceEvent;
}

describe('window dialogue context', () => {
  it('includes subtitles and transcribed speech that overlap the window', () => {
    const events = [
      subtitle(10_000, 11_000, 'You will tell us how you found him.'),
      speech(11_500, 12_500, 'I am psychic.', 'speaker-2'),
      subtitle(30_000, 31_000, 'Much later.'),
    ];
    const dialogue = dialogueInWindow(events, 10_000, 14_000);
    expect(dialogue.map((d) => d.text)).toEqual([
      'You will tell us how you found him.',
      'I am psychic.',
    ]);
    expect(dialogue[1]!.speakerId).toBe('speaker-2');
  });

  it('carries a line spoken just before the window, clamped to the window start', () => {
    const events = [subtitle(9_000, 9_600, 'How was it for you?')];
    const dialogue = dialogueInWindow(events, 10_000, 14_000);
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0]!.start).toBe(10_000);
    expect(dialogueInWindow(events, 9_600 + DIALOGUE_LEAD_IN_MS + 1, 20_000)).toEqual([]);
  });

  it('leaves bracketed non-speech captions out of dialogue', () => {
    const events = [subtitle(10_000, 11_000, '[door slams]', { nonSpeech: true })];
    expect(dialogueInWindow(events, 10_000, 14_000)).toEqual([]);
  });

  it('uses a subtitle speaker label as the speaker', () => {
    const events = [subtitle(10_000, 11_000, 'Go.', { speakerLabel: 'JANE' })];
    expect(dialogueInWindow(events, 10_000, 14_000)[0]!.speakerId).toBe('JANE');
  });

  it('selects sound events inside the window only', () => {
    const events = [sound(9_000), sound(11_000, 'impact'), sound(20_000)];
    expect(soundsInWindow(events, 10_000, 14_000)).toEqual([{ start: 11_000, kind: 'impact' }]);
  });
});

describe('recent window context', () => {
  it('serves a window from recorded subtitle and audio evidence', () => {
    const context = new RecentWindowContext();
    context.record([subtitle(10_000, 11_000, 'That felt good.'), sound(10_500)]);
    const window = context.forWindow(10_000, 12_000);
    expect(window.dialogue.map((d) => d.text)).toEqual(['That felt good.']);
    expect(window.soundEvents).toHaveLength(1);
  });

  it('ignores evidence that is not dialogue or sound', () => {
    const context = new RecentWindowContext();
    context.record([
      { ...base, id: 'v', source: 'video', start: 1, payload: { kind: 'scene-change' } } as EvidenceEvent,
    ]);
    expect(context.size).toBe(0);
  });

  it('forgets evidence older than its horizon and beyond its size', () => {
    const context = new RecentWindowContext({ horizonMs: 10_000, maxEvents: 3 });
    context.record([subtitle(0, 1_000, 'old')]);
    context.record([subtitle(50_000, 51_000, 'new')]);
    expect(context.forWindow(0, 2_000).dialogue).toEqual([]);
    expect(context.size).toBe(1);

    context.record([1, 2, 3, 4].map((n) => subtitle(51_000 + n, 51_500 + n, `n${n}`)));
    expect(context.size).toBe(3);
  });

  it('is empty after clear', () => {
    const context = new RecentWindowContext();
    context.record([subtitle(0, 1_000, 'x')]);
    context.clear();
    expect(context.forWindow(0, 2_000).dialogue).toEqual([]);
  });
});
