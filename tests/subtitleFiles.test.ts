import { describe, expect, it } from 'vitest';
import {
  cuesToEvidence,
  detectSubtitleFormat,
  languageFromFilename,
  parseSubtitleFile,
  parseTimestamp,
} from '@/capture/subtitle/parseSubtitleFile';
import { buildScreenplay, collectLanguages, summarizeBeats } from '@/core/pipeline';
import { gapStrength } from '@/scenes/boundaries';

const SRT = `1
00:00:05,000 --> 00:00:07,500
JIYEON: We're out of milk.

2
00:00:08,000 --> 00:00:10,000
[refrigerator door closes]

3
00:00:11,200 --> 00:00:13,800
DANIEL: I'll go get some.
`;

const VTT = `WEBVTT

NOTE This is a comment block that must be ignored.

00:00:01.000 --> 00:00:03.000
First line

00:00:04.000 --> 00:00:06.000
Second line
`;

describe('timestamp parsing', () => {
  it.each([
    ['00:00:05,000', 5_000],
    ['00:01:02,345', 62_345],
    ['01:02:03.456', 3_723_456],
    ['02:03.500', 123_500],
  ])('parses %s', (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  it('pads short millisecond fields', () => {
    expect(parseTimestamp('00:00:01,5')).toBe(1_500);
  });

  it('returns null for nonsense rather than a guess', () => {
    expect(parseTimestamp('not a timestamp')).toBeNull();
  });
});

describe('format detection', () => {
  it('detects WebVTT from its header, not its extension', () => {
    expect(detectSubtitleFormat(VTT)).toBe('vtt');
    expect(detectSubtitleFormat('﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi')).toBe('vtt');
  });

  it('detects SRT from its structure', () => {
    expect(detectSubtitleFormat(SRT)).toBe('srt');
  });

  it('reports unknown rather than guessing', () => {
    expect(detectSubtitleFormat('just some prose')).toBe('unknown');
  });
});

describe('subtitle file parsing', () => {
  it('parses SRT cues with timings and text', () => {
    const result = parseSubtitleFile(SRT);
    expect(result.format).toBe('srt');
    expect(result.cues).toHaveLength(3);
    expect(result.cues[0]).toMatchObject({ start: 5_000, end: 7_500, text: "JIYEON: We're out of milk." });
  });

  it('parses WebVTT and ignores NOTE blocks', () => {
    const result = parseSubtitleFile(VTT);
    expect(result.cues).toHaveLength(2);
    expect(result.cues.map((c) => c.text)).toEqual(['First line', 'Second line']);
  });

  it('tolerates CRLF, a BOM, and dots instead of commas', () => {
    const messy = '﻿1\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n';
    const result = parseSubtitleFile(messy);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe('Hello');
  });

  it('parses cues that omit the index line', () => {
    const noIndex = '00:00:01,000 --> 00:00:02,000\nHello\n\n00:00:03,000 --> 00:00:04,000\nAgain\n';
    expect(parseSubtitleFile(noIndex).cues).toHaveLength(2);
  });

  it('preserves multi-line cues as lines', () => {
    const multi = '1\n00:00:01,000 --> 00:00:03,000\n- Where are you?\n- Here.\n';
    const [cue] = parseSubtitleFile(multi).cues;
    expect(cue!.lines).toEqual(['- Where are you?', '- Here.']);
  });

  it('sorts out-of-order cues into media order', () => {
    const shuffled =
      '2\n00:00:10,000 --> 00:00:12,000\nSecond\n\n1\n00:00:01,000 --> 00:00:03,000\nFirst\n';
    expect(parseSubtitleFile(shuffled).cues.map((c) => c.text)).toEqual(['First', 'Second']);
  });

  it('skips unparseable blocks and reports the count instead of guessing', () => {
    const broken = '1\n00:00:01,000 --> 00:00:02,000\nGood\n\nthis block has text but no timing\n';
    const result = parseSubtitleFile(broken);
    expect(result.cues).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings.join(' ')).toContain('skipped');
  });

  it('repairs a cue that ends before it starts, and says so', () => {
    const inverted = '1\n00:00:10,000 --> 00:00:05,000\nBackwards\n';
    const result = parseSubtitleFile(inverted);
    expect(result.cues[0]!.end).toBeGreaterThan(result.cues[0]!.start);
    expect(result.warnings.join(' ')).toContain('ends before it starts');
  });

  it('reports plainly when a file yields nothing', () => {
    const result = parseSubtitleFile('this is not a subtitle file at all');
    expect(result.cues).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('No cues could be read');
  });
});

describe('language from filename', () => {
  it.each([
    ['movie.ko.srt', 'ko'],
    ['movie_en.vtt', 'en'],
    ['show-ja.srt', 'ja'],
    ['movie.pt-BR.srt', 'pt'],
  ])('reads %s as %s', (name, expected) => {
    expect(languageFromFilename(name)).toBe(expected);
  });

  it('returns undetermined when there is no marker, rather than assuming English', () => {
    expect(languageFromFilename('movie.srt')).toBe('und');
    expect(languageFromFilename('episode-01.vtt')).toBe('und');
  });
});

describe('cues to evidence', () => {
  it('marks authored tracks as high confidence and generated ones as medium', () => {
    const cues = parseSubtitleFile(SRT).cues;
    expect(cuesToEvidence(cues, { language: 'en' })[0]!.confidence).toBe('high');
    expect(cuesToEvidence(cues, { language: 'en', autoGenerated: true })[0]!.confidence).toBe('medium');
  });

  it('produces unique ids', () => {
    const events = cuesToEvidence(parseSubtitleFile(SRT).cues, { language: 'en' });
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe('one-pass pipeline', () => {
  const evidenceFor = (content: string, language: string) =>
    cuesToEvidence(parseSubtitleFile(content).cues, { language, idPrefix: language });

  it('builds a finalized screenplay from subtitle evidence', () => {
    const result = buildScreenplay(evidenceFor(SRT, 'en'));

    expect(result.scenes.length).toBeGreaterThan(0);
    // A one-pass build has nothing later to revise it, so nothing stays provisional.
    expect(result.scenes.every((s) => s.status === 'finalized')).toBe(true);

    const counts = summarizeBeats(result.scenes);
    expect(counts.dialogue).toBe(2);
    // The bracketed caption became a sound beat, not a third line of dialogue.
    expect(counts.sound).toBe(1);
  });

  it('attributes speakers from subtitle labels', () => {
    const result = buildScreenplay(evidenceFor(SRT, 'en'));
    const names = result.characters.map((c) => c.displayName);
    expect(names).toContain('JIYEON');
    expect(names).toContain('DANIEL');
  });

  it('merges two languages into shared beats with per-language variants', () => {
    const ko = `1
00:00:05,000 --> 00:00:07,500
지연: 우유가 없네.

2
00:00:11,200 --> 00:00:13,800
다니엘: 내가 사올게.
`;
    const result = buildScreenplay([...evidenceFor(SRT, 'en'), ...evidenceFor(ko, 'ko')]);

    expect(result.languages.sort()).toEqual(['en', 'ko']);
    const dialogue = result.scenes.flatMap((s) => s.beats).filter((b) => b.type === 'dialogue');
    // Two shared beats, each with both languages — not four separate beats.
    expect(dialogue).toHaveLength(2);
    expect(Object.keys(dialogue[0]!.textVariants).sort()).toEqual(['en', 'ko']);
  });

  it('renders the requested language', () => {
    const result = buildScreenplay(evidenceFor(SRT, 'en'), { language: 'en' });
    const line = result.document.lines.find((l) => l.kind === 'dialogue');
    expect(line!.text).toBe("We're out of milk.");
  });

  it('reports partial coverage when evidence is sparse', () => {
    // Two lines ten minutes apart, with no claim of a complete source.
    const sparse = `1
00:00:01,000 --> 00:00:03,000
Start

2
00:10:00,000 --> 00:10:02,000
Much later
`;
    const result = buildScreenplay(evidenceFor(sparse, 'en'), { durationMs: 600_000 });
    expect(result.coverage.ratio).toBeLessThan(0.1);
    expect(result.coverage.uncovered.length).toBeGreaterThan(0);
    expect(result.coverage.notes.join(' ')).toContain('Unobserved ranges');
  });

  it('reports full coverage when the source is known to be complete', () => {
    // The distinction that stops a complete subtitle file reading as 2% analyzed.
    const sparse = `1
00:00:01,000 --> 00:00:03,000
Start

2
00:10:00,000 --> 00:10:02,000
Much later
`;
    const result = buildScreenplay(evidenceFor(sparse, 'en'), {
      durationMs: 602_000,
      completeSourceRange: { start: 0, end: 602_000 },
    });
    expect(result.coverage.ratio).toBe(1);
    expect(result.coverage.uncovered).toHaveLength(0);
  });

  it('collects languages in first-seen order and drops undetermined', () => {
    const result = buildScreenplay([
      ...evidenceFor(SRT, 'en'),
      ...evidenceFor(SRT, 'und'),
    ]);
    expect(collectLanguages(result.scenes)).toEqual(['en']);
  });

  it('handles empty evidence without throwing', () => {
    const result = buildScreenplay([]);
    expect(result.scenes).toEqual([]);
    expect(result.document.lines).toEqual([]);
    expect(result.languages).toEqual([]);
  });
});

describe('scene boundaries from subtitle-only evidence', () => {
  const fmt = (t: number) => {
    const h = String(Math.floor(t / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor(t / 60_000) % 60).padStart(2, '0');
    const s = String(Math.floor(t / 1_000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
  };

  /** Builds an SRT from explicit cue start times. */
  const srtFrom = (starts: number[], durationMs = 2_000) =>
    starts
      .map((start, i) => `${i + 1}\n${fmt(start)} --> ${fmt(start + durationMs)}\nLine ${i}\n`)
      .join('\n');

  const build = (srt: string) =>
    buildScreenplay(cuesToEvidence(parseSubtitleFile(srt).cues, { language: 'en' }));

  it('breaks a scene at a gap that is exceptional for the track', () => {
    // Chatter every ~4 s, then a 90-second hole, then chatter again. With no
    // picture and no audio, that hole is the only evidence a scene changed —
    // and it has to be enough, or subtitle-only input yields one giant scene.
    const starts = [
      0, 4_000, 8_000, 12_000, 16_000, 20_000,
      110_000, 114_000, 118_000, 122_000, 126_000,
    ];
    const result = build(srtFrom(starts));
    expect(result.scenes.length).toBeGreaterThanOrEqual(2);
  });

  it('does not break on the ordinary rhythm of a talkative track', () => {
    // Uniform 4-second spacing throughout: nothing is exceptional, so nothing
    // may be claimed as a scene change.
    const starts = Array.from({ length: 30 }, (_, i) => i * 4_000);
    expect(build(srtFrom(starts)).scenes).toHaveLength(1);
  });

  it('does not break on a gap that is ordinary for a sparse track', () => {
    // Every gap is 30 s; a 30-second gap is this track's normal rhythm.
    const starts = Array.from({ length: 12 }, (_, i) => i * 32_000);
    expect(build(srtFrom(starts)).scenes).toHaveLength(1);
  });

  it('scores gap strength against the track rhythm, not an absolute constant', () => {
    // The same 30-second gap means different things in different films.
    expect(gapStrength(30_000, 3_000)).toBe(1);
    expect(gapStrength(30_000, 30_000)).toBe(0);
    expect(gapStrength(30_000, 10_000)).toBeCloseTo(1 / 6, 5);
    // No rhythm to compare against: fall back to an absolute scale.
    expect(gapStrength(30_000, 0)).toBe(1);
    expect(gapStrength(6_000, 0)).toBeCloseTo(0.2, 5);
  });
});
