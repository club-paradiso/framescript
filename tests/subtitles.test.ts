import { describe, expect, it } from 'vitest';
import {
  normalizeSubtitleText,
  rollUpOverlap,
  splitDashedLines,
  SubtitleAccumulator,
  type RawSubtitleObservation,
} from '@/capture/subtitle/normalize';
import { extractSpeakerLabel, isNonSpeechCaption } from '@/characters/attribution';
import { comparableText, isProgressiveExtension } from '@/utils/text';

const obs = (text: string, mediaTime: number, language = 'en'): RawSubtitleObservation => ({
  text,
  mediaTime,
  language,
});

/** Feeds a script of observations and returns every cue that completed. */
function run(script: RawSubtitleObservation[], flushAt?: number) {
  const acc = new SubtitleAccumulator();
  const cues = script.flatMap((o) => acc.observe(o));
  const tail = acc.flush(flushAt);
  return tail ? [...cues, tail] : cues;
}

describe('text normalization', () => {
  it('strips zero-width characters and collapses whitespace per line', () => {
    const { text } = normalizeSubtitleText('  I​ don’t   think \n\n  we should go.  ');
    expect(text).toBe('I don’t think we should go.');
  });

  it('preserves line structure', () => {
    const { lines } = normalizeSubtitleText('- Where are you?\n- Here.');
    expect(lines).toEqual(['- Where are you?', '- Here.']);
  });

  it('drops empty lines produced by styling spans', () => {
    const { lines } = normalizeSubtitleText('Hello\n\n \nthere');
    expect(lines).toEqual(['Hello', 'there']);
  });

  it('normalizes non-breaking spaces', () => {
    expect(normalizeSubtitleText('a b').text).toBe('a b');
  });
});

describe('comparable text', () => {
  it('ignores case, punctuation and quote style', () => {
    expect(comparableText("I don't.")).toBe(comparableText('I DONT'));
    expect(comparableText('“Hello,” he said')).toBe(comparableText('hello he said'));
  });

  it('detects progressive extension only when the prefix truly matches', () => {
    expect(isProgressiveExtension("I don't", "I don't think")).toBe(true);
    expect(isProgressiveExtension("I don't think", "I don't")).toBe(false);
    expect(isProgressiveExtension('Hello there', 'Goodbye there')).toBe(false);
    // A prefix match that is not on a word boundary is not an extension.
    expect(isProgressiveExtension('go', 'gone fishing')).toBe(false);
  });
});

describe('YouTube progressive captions', () => {
  it('collapses a word-by-word caption into one cue', () => {
    const cues = run(
      [
        obs("I don't", 1000),
        obs("I don't think", 1200),
        obs("I don't think we", 1400),
        obs("I don't think we should go.", 1700),
        obs('', 3000),
      ],
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("I don't think we should go.");
    expect(cues[0]!.start).toBe(1000);
    expect(cues[0]!.progressive).toBe(true);
  });

  it('does not merge two unrelated cues', () => {
    const cues = run([
      obs('Where are you?', 1000),
      obs('', 2500),
      obs('I am here.', 3000),
      obs('', 4500),
    ]);
    expect(cues.map((c) => c.text)).toEqual(['Where are you?', 'I am here.']);
  });

  it('starts a new cue when text changes without extending', () => {
    const cues = run([obs('First line', 1000), obs('Second line', 2000), obs('', 3000)]);
    expect(cues.map((c) => c.text)).toEqual(['First line', 'Second line']);
  });

  it('deduplicates identical re-renders and keeps one cue', () => {
    const cues = run([
      obs('Same text', 1000),
      obs('Same text', 1050),
      obs('Same text', 1100),
      obs('Same text', 1150),
      obs('', 2000),
    ]);
    expect(cues).toHaveLength(1);
    // The cue must span the whole display, not just the first observation.
    expect(cues[0]!.end).toBeGreaterThanOrEqual(2000);
  });

  it('closes a cue when the caption goes idle without clearing', () => {
    const cues = run([obs('Hanging cue', 1000), obs('Totally different', 9000), obs('', 11000)]);
    expect(cues.map((c) => c.text)).toEqual(['Hanging cue', 'Totally different']);
  });

  it('discards render flicker shorter than the minimum duration', () => {
    const cues = run([obs('x', 1000), obs('', 1010)]);
    expect(cues).toHaveLength(0);
  });

  it('splits when the subtitle language changes mid-stream', () => {
    const cues = run([obs('Hello', 1000, 'en'), obs('안녕하세요', 1500, 'ko'), obs('', 3000, 'ko')]);
    expect(cues.map((c) => c.language)).toEqual(['en', 'ko']);
  });

  it('flushes a pending cue on demand', () => {
    const acc = new SubtitleAccumulator();
    acc.observe(obs('Unclosed line', 1000));
    expect(acc.hasPending).toBe(true);
    const cue = acc.flush(2500);
    expect(cue?.text).toBe('Unclosed line');
    expect(acc.hasPending).toBe(false);
  });
});

describe('roll-up captions', () => {
  it('measures the word overlap between consecutive displays', () => {
    expect(rollUpOverlap('A B C', 'B C D')).toBe(2);
    expect(rollUpOverlap('A B C', 'D E F')).toBe(0);
    expect(rollUpOverlap('hello world', 'world')).toBe(1);
  });

  it('emits each rolled line once rather than duplicating the overlap', () => {
    const cues = run([
      obs('the first line here', 1000),
      obs('first line here and second', 2000),
      obs('', 3500),
    ]);
    const joined = cues.map((c) => c.text).join(' | ');
    expect(cues.length).toBeGreaterThanOrEqual(2);
    // "first line here" must not appear twice in the output.
    expect(joined.match(/first line here/g)?.length).toBe(1);
  });
});

describe('speaker labels', () => {
  it.each([
    ['JANE: Where are you?', 'JANE', 'Where are you?'],
    ['- JANE: Hi', 'JANE', 'Hi'],
    ['[JANE] Hi there', 'JANE', 'Hi there'],
    ['(NARRATOR) Once upon a time', 'NARRATOR', 'Once upon a time'],
  ])('extracts a label from %s', (input, speaker, remainder) => {
    const result = extractSpeakerLabel(input);
    expect(result.speaker).toBe(speaker);
    expect(result.remainder).toBe(remainder);
  });

  it('does not mistake ordinary dialogue for a speaker label', () => {
    // Lower case, and a sentence — not a caption-track speaker cue.
    expect(extractSpeakerLabel('well, here is the thing: I disagree').speaker).toBeUndefined();
    expect(extractSpeakerLabel('Listen to me. Now: go.').speaker).toBeUndefined();
  });

  it('accepts CJK labels, which have no upper case to test', () => {
    expect(extractSpeakerLabel('지연: 우유가 없네.').speaker).toBe('지연');
  });

  it('rejects overly long candidates', () => {
    const long = 'THIS IS A VERY LONG PIECE OF SPEECH THAT SHOULD NOT BE A NAME: hello';
    expect(extractSpeakerLabel(long).speaker).toBeUndefined();
  });
});

describe('non-speech captions', () => {
  it.each(['[door slams]', '(gunshot)', '♪ music ♪'])('recognises %s as non-speech', (text) => {
    expect(isNonSpeechCaption(text)).toBe(true);
  });

  it('does not treat a labelled dialogue line as non-speech', () => {
    expect(isNonSpeechCaption('[JANE] Where are you?')).toBe(false);
    expect(isNonSpeechCaption('Where are you?')).toBe(false);
  });
});

describe('dashed lines', () => {
  it('splits two-speaker captions', () => {
    expect(splitDashedLines(['- Where are you?', '- Here.'])).toEqual(['Where are you?', 'Here.']);
  });

  it('joins ordinary wrapped lines into one', () => {
    expect(splitDashedLines(['I think we', 'should go now.'])).toEqual(['I think we should go now.']);
  });
});
