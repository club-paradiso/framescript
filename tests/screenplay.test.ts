import { describe, expect, it } from 'vitest';
import {
  coverageNote,
  documentToText,
  formatSceneHeading,
  renderScreenplay,
} from '@/screenplay/languageRenderer';
import { alignCueTracks, groupToDualText } from '@/screenplay/alignment';
import { findMatch, searchScreenplay } from '@/screenplay/search';
import { buildFilename, exportScreenplay, toSrt, RECONSTRUCTION_NOTICE } from '@/screenplay/export';
import { toFountain } from '@/screenplay/export/fountain';
import { activeLineIndex } from '@/screenplay/types';
import { dialogueTextFor } from '@/scenes/types';
import { slugify } from '@/utils/text';
import { formatSrtTimestamp, formatTimecode } from '@/utils/time';
import type { CharacterEntity } from '@/characters/entities';
import type { DialogueBeat, ReconstructedScene, SceneBeat } from '@/scenes/types';
import type { Provenance } from '@/evidence/types';

const provenance: Provenance = {
  evidenceIds: ['e1'],
  sources: ['subtitle'],
  confidence: 'high',
  inferred: false,
};

const characters: CharacterEntity[] = [
  {
    id: 'c1',
    displayName: 'JIYEON',
    aliases: [],
    speakerIds: ['speaker-001'],
    visualClusterIds: [],
    confidence: 'high',
    source: 'subtitle',
    lineCount: 1,
  },
];

const dialogue = (
  start: number,
  variants: Record<string, { text: string; origin: 'platform-subtitle' | 'audio-asr' | 'ai-translation' }>,
  characterId = 'c1',
): DialogueBeat => ({
  type: 'dialogue',
  id: `d${start}`,
  start,
  end: start + 2000,
  characterId,
  textVariants: Object.fromEntries(
    Object.entries(variants).map(([language, v]) => [
      language,
      { language, text: v.text, origin: v.origin, confidence: 'high' as const },
    ]),
  ),
  provenance,
});

const scene = (beats: SceneBeat[], setting?: ReconstructedScene['setting']): ReconstructedScene => ({
  id: 's1',
  start: beats[0]?.start ?? 0,
  end: 20_000,
  ...(setting ? { setting } : {}),
  characters: [],
  beats,
  provenance,
  status: 'finalized',
});

describe('scene headings', () => {
  it('renders a fully-evidenced heading', () => {
    expect(
      formatSceneHeading(
        { description: 'kitchen', interiorExterior: 'INT', timeOfDay: 'DAY', confidence: 'high', inferred: false },
        'en',
      ),
    ).toBe('INT. KITCHEN - DAY');
  });

  it('stays vague when the time of day is unknown', () => {
    // "INT. ROOM - UNKNOWN TIME" is correct; inventing "NIGHT" would not be.
    expect(
      formatSceneHeading({ description: 'room', interiorExterior: 'INT', confidence: 'low', inferred: true }, 'en'),
    ).toBe('INT. ROOM - UNKNOWN TIME');
  });

  it('omits the heading entirely when there is no setting evidence', () => {
    expect(formatSceneHeading(undefined, 'en')).toBeNull();
    expect(formatSceneHeading({ confidence: 'unknown', inferred: true }, 'en')).toBeNull();
  });

  it('localizes structural vocabulary', () => {
    const setting = { description: '주방', interiorExterior: 'INT' as const, timeOfDay: 'DAY', confidence: 'high' as const, inferred: false };
    expect(formatSceneHeading(setting, 'ko')).toContain('실내.');
    expect(formatSceneHeading(setting, 'ko')).toContain('낮');
    expect(formatSceneHeading(setting, 'ja')).toContain('屋内.');
  });

  it('falls back to English convention for unsupported languages', () => {
    const setting = { description: 'kitchen', interiorExterior: 'EXT' as const, timeOfDay: 'NIGHT', confidence: 'high' as const, inferred: false };
    expect(formatSceneHeading(setting, 'sw')).toBe('EXT. KITCHEN - NIGHT');
  });
});

describe('language rendering', () => {
  const shared = scene([
    {
      type: 'action',
      id: 'a1',
      start: 500,
      description: 'Jiyeon opens the refrigerator.',
      provenance,
    },
    dialogue(1000, {
      en: { text: "We're out of milk.", origin: 'platform-subtitle' },
      ko: { text: '우유가 없네.', origin: 'platform-subtitle' },
    }),
  ]);

  it('renders the same scene model into different languages', () => {
    const english = renderScreenplay([shared], { language: 'en', characters });
    const korean = renderScreenplay([shared], { language: 'ko', characters });

    expect(english.lines.find((l) => l.kind === 'dialogue')!.text).toBe("We're out of milk.");
    expect(korean.lines.find((l) => l.kind === 'dialogue')!.text).toBe('우우가 없네.'.replace('우우', '우유'));
  });

  it('emits a character cue before each line', () => {
    const document = renderScreenplay([shared], { language: 'en', characters });
    const cueIndex = document.lines.findIndex((l) => l.kind === 'character');
    expect(document.lines[cueIndex]!.text).toBe('JIYEON');
    expect(document.lines[cueIndex + 1]!.kind).toBe('dialogue');
  });

  it('labels a fallback when the target language has no variant', () => {
    const document = renderScreenplay([shared], { language: 'ja', characters, fallbackLanguages: ['en'] });
    const line = document.lines.find((l) => l.kind === 'dialogue')!;
    expect(line.text).toBe("We're out of milk.");
    // The reader must know this is not Japanese subtitle text.
    expect(line.fallbackLanguage).toBe('en');
  });

  it('never presents an AI translation as a platform subtitle', () => {
    const translated = scene([
      dialogue(1000, {
        en: { text: 'Original line', origin: 'platform-subtitle' },
        ja: { text: '翻訳された行', origin: 'ai-translation' },
      }),
    ]);
    const document = renderScreenplay([translated], { language: 'ja', characters });
    const line = document.lines.find((l) => l.kind === 'dialogue')!;
    expect(line.origin).toBe('ai-translation');
  });

  it('prefers a real subtitle in another language over an AI translation', () => {
    const beat = dialogue(1000, {
      en: { text: 'Real subtitle', origin: 'platform-subtitle' },
      fr: { text: 'Machine translation', origin: 'ai-translation' },
    });
    const variant = dialogueTextFor(beat, 'de', []);
    expect(variant!.origin).toBe('platform-subtitle');
  });

  it('shows a second language only when it is genuinely a different variant', () => {
    const withSecondary = renderScreenplay([shared], {
      language: 'en',
      secondaryLanguage: 'ko',
      characters,
    });
    expect(withSecondary.lines.find((l) => l.kind === 'dialogue')!.secondaryText).toBe('우유가 없네.');

    // No Japanese track exists, so there is nothing to show in the second column.
    const noSecondary = renderScreenplay([shared], {
      language: 'en',
      secondaryLanguage: 'ja',
      characters,
    });
    expect(noSecondary.lines.find((l) => l.kind === 'dialogue')!.secondaryText).toBeUndefined();
  });

  it('marks untranslated action lines rather than pretending they were localized', () => {
    const document = renderScreenplay([shared], { language: 'ko', characters });
    const actionLine = document.lines.find((l) => l.kind === 'action')!;
    expect(actionLine.text).toBe('Jiyeon opens the refrigerator.');
    expect(actionLine.fallbackLanguage).toBe('en');
  });

  it('uses a localized action line when a provider produced one', () => {
    const localized = scene([
      {
        type: 'action',
        id: 'a1',
        start: 500,
        description: 'Jiyeon opens the refrigerator.',
        localized: { ko: '지연이 냉장고를 연다.' },
        provenance,
      },
    ]);
    const document = renderScreenplay([localized], { language: 'ko', characters });
    const line = document.lines.find((l) => l.kind === 'action')!;
    expect(line.text).toBe('지연이 냉장고를 연다.');
    expect(line.fallbackLanguage).toBeUndefined();
  });

  it('can omit transitions', () => {
    const withTransition = scene([
      { type: 'transition', id: 't1', start: 100, label: 'CUT TO:', provenance },
      dialogue(1000, { en: { text: 'Line', origin: 'platform-subtitle' } }),
    ]);
    expect(
      renderScreenplay([withTransition], { language: 'en', characters, includeTransitions: false }).lines.some(
        (l) => l.kind === 'transition',
      ),
    ).toBe(false);
  });
});

describe('playback following', () => {
  const document = renderScreenplay(
    [
      scene([
        dialogue(1000, { en: { text: 'First', origin: 'platform-subtitle' } }),
        dialogue(5000, { en: { text: 'Second', origin: 'platform-subtitle' } }),
        dialogue(9000, { en: { text: 'Third', origin: 'platform-subtitle' } }),
      ]),
    ],
    { language: 'en', characters },
  );

  it('finds the active line for a playback position', () => {
    expect(activeLineIndex(document, 0)).toBe(-1);
    expect(document.lines[activeLineIndex(document, 6000)]!.text).toMatch(/Second|JIYEON/);
    expect(document.lines[activeLineIndex(document, 999_999)]!.text).toMatch(/Third|JIYEON/);
  });
});

describe('cross-language alignment', () => {
  const en = (start: number, end: number, text: string) => ({ start, end, text, language: 'en' });
  const ko = (start: number, end: number, text: string) => ({ start, end, text, language: 'ko' });

  it('pairs one-to-one cues', () => {
    const groups = alignCueTracks([en(0, 2000, 'Hello')], [ko(100, 2100, '안녕')]);
    expect(groups).toHaveLength(1);
    expect(groupToDualText(groups[0]!)).toEqual({ primary: 'Hello', secondary: '안녕' });
  });

  it('handles a many-to-one split without printing the shared line twice', () => {
    // Two English cues over one Korean cue.
    const groups = alignCueTracks(
      [en(0, 1000, 'I think'), en(1000, 2000, 'we should go.')],
      [ko(0, 2000, '우리 가야 할 것 같아.')],
    );
    const koreanAppearances = groups.flatMap((g) => g.secondary).length;
    expect(koreanAppearances).toBe(1);
    expect(groups[0]!.primary).toHaveLength(2);
  });

  it('does not assume index correspondence', () => {
    // A line missing from the Korean track must not shift every later pairing.
    const groups = alignCueTracks(
      [en(0, 1000, 'One'), en(2000, 3000, 'Two'), en(4000, 5000, 'Three')],
      [ko(0, 1000, '하나'), ko(4000, 5000, '셋')],
    );
    const two = groups.find((g) => g.primary[0]?.text === 'Two');
    expect(two!.secondary).toHaveLength(0);
    const three = groups.find((g) => g.primary[0]?.text === 'Three');
    expect(three!.secondary[0]!.text).toBe('셋');
  });

  it('keeps a cue that exists only in the secondary track', () => {
    const groups = alignCueTracks([en(0, 1000, 'Only English')], [ko(5000, 6000, '한국어만')]);
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.primary.length === 0)).toBe(true);
  });

  it('refuses to pair cues that barely overlap', () => {
    const groups = alignCueTracks([en(0, 2000, 'Hello')], [ko(1900, 4000, '한참 뒤')], {
      minOverlapRatio: 0.5,
    });
    expect(groups[0]!.secondary).toHaveLength(0);
  });
});

describe('search', () => {
  const scenes = [
    scene([
      dialogue(1000, {
        en: { text: "We're out of milk.", origin: 'platform-subtitle' },
        ko: { text: '우유가 없네.', origin: 'platform-subtitle' },
      }),
      { type: 'action', id: 'a1', start: 3000, description: 'She opens the refrigerator.', provenance },
    ]),
  ];

  it('finds dialogue regardless of punctuation and case', () => {
    expect(searchScreenplay(scenes, 'out of milk', { language: 'en' })).toHaveLength(1);
    expect(searchScreenplay(scenes, 'OUT OF MILK', { language: 'en' })).toHaveLength(1);
  });

  it('searches action lines', () => {
    const results = searchScreenplay(scenes, 'refrigerator', { scope: 'action' });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe('action');
  });

  it('searches other languages when asked', () => {
    expect(searchScreenplay(scenes, '우유', { allLanguages: true })).toHaveLength(1);
    expect(searchScreenplay(scenes, '우유', { language: 'en', allLanguages: false })).toHaveLength(0);
  });

  it('searches by speaker name', () => {
    const results = searchScreenplay(scenes, 'JIYEON', { scope: 'speaker', characters });
    expect(results).toHaveLength(1);
  });

  it('returns nothing for an empty query', () => {
    expect(searchScreenplay(scenes, '   ')).toHaveLength(0);
  });

  it('maps match offsets back onto the original punctuated text', () => {
    const match = findMatch("We're out of milk.", 'out of milk');
    expect(match).not.toBeNull();
    expect("We're out of milk.".slice(match!.start, match!.start + match!.length)).toContain('out of milk');
  });
});

describe('export', () => {
  const document = renderScreenplay(
    [
      scene(
        [
          { type: 'action', id: 'a1', start: 500, description: 'Jiyeon opens the refrigerator.', provenance },
          dialogue(1000, { en: { text: "We're out of milk.", origin: 'platform-subtitle' } }),
        ],
        { description: 'kitchen', interiorExterior: 'INT', timeOfDay: 'DAY', confidence: 'high', inferred: false },
      ),
    ],
    { language: 'en', characters },
  );

  const metadata = { title: 'Sundae', seriesTitle: 'The Bear', season: 2, episode: 3, platform: 'netflix' as const };

  it('produces Fountain with the reconstruction disclaimer', () => {
    const fountain = toFountain(document, metadata);
    expect(fountain).toContain('Title: The Bear S02E03');
    expect(fountain).toContain('.INT. KITCHEN - DAY');
    expect(fountain).toContain('JIYEON');
    expect(fountain).toContain("We're out of milk.");
    // Never claim to be the real screenplay.
    expect(fountain).toContain('NOT an original, shooting, or production screenplay');
  });

  it('forces scene headings so localized ones are not misparsed', () => {
    const korean = renderScreenplay(
      [scene([dialogue(1000, { ko: { text: '우유가 없네.', origin: 'platform-subtitle' } })], {
        description: '주방',
        interiorExterior: 'INT',
        timeOfDay: 'DAY',
        confidence: 'high',
        inferred: false,
      })],
      { language: 'ko', characters },
    );
    expect(toFountain(korean, metadata)).toContain('.실내. 주방');
  });

  it('annotates timestamps, confidence and sources on request', () => {
    const fountain = toFountain(document, metadata, {
      includeTimestamps: true,
      includeConfidence: true,
      includeEvidenceRefs: true,
    });
    expect(fountain).toMatch(/\[\[.*high.*\]\]/);
    expect(fountain).toContain('Subtitle');
  });

  it('includes the coverage report so gaps are never implied to be analyzed', () => {
    const fountain = toFountain(document, {
      ...metadata,
      coverage: coverageNote(0.82, [{ start: 10_000, end: 20_000 }]),
    });
    expect(fountain).toContain('82%');
    expect(fountain).toContain('Unobserved ranges');
  });

  it('exports only dialogue to SRT, never action', () => {
    const srt = toSrt(document);
    expect(srt).toContain("We're out of milk.");
    // Action is not something anyone said.
    expect(srt).not.toContain('refrigerator');
    expect(srt).toMatch(/00:00:0\d,\d{3} --> /);
  });

  it('carries the notice into every format', () => {
    for (const format of ['markdown', 'text', 'json'] as const) {
      const result = exportScreenplay(document, metadata, { format });
      expect(result.content).toContain('Reconstructed by FrameScript');
    }
    expect(RECONSTRUCTION_NOTICE).toContain('not an original');
  });

  it('produces valid JSON carrying provenance', () => {
    const result = exportScreenplay(document, metadata, { format: 'json' });
    const parsed = JSON.parse(result.content) as { lines: { provenance?: Provenance }[]; notice: string };
    expect(parsed.notice).toBeTruthy();
    expect(parsed.lines.some((l) => l.provenance?.sources.includes('subtitle'))).toBe(true);
  });

  it('can export dialogue only', () => {
    const result = exportScreenplay(document, metadata, { format: 'text', dialogueOnly: true });
    expect(result.content).toContain("We're out of milk.");
    expect(result.content).not.toContain('refrigerator');
  });

  it('builds filesystem-safe filenames', () => {
    expect(buildFilename(metadata, 'ko', 'fountain')).toBe('the-bear-s02e03.ko.fountain');
    expect(buildFilename({ title: 'A Film: Part 2 / Redux' }, 'en', 'md')).toBe('a-film-part-2-redux.en.md');
    expect(buildFilename({}, 'en', 'txt')).toBe('framescript.en.txt');
  });

  it('sanitizes filesystem-invalid characters', () => {
    expect(slugify('a/b\\c:d*e?f"g<h>i|j')).not.toMatch(/[/\\:*?"<>|]/);
    expect(slugify('')).toBe('framescript');
    expect(slugify('한국어 제목')).toBe('한국어-제목');
  });
});

describe('formatting', () => {
  it('formats timecodes', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(65_000)).toBe('1:05');
    expect(formatTimecode(3_725_000)).toBe('1:02:05');
    expect(formatTimecode(1_234, { millis: true })).toBe('0:01.234');
  });

  it('formats SRT timestamps', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    expect(formatSrtTimestamp(3_725_123)).toBe('01:02:05,123');
  });

  it('lays out plain text in screenplay form', () => {
    const document = renderScreenplay(
      [scene([dialogue(1000, { en: { text: 'Line one', origin: 'platform-subtitle' } })])],
      { language: 'en', characters },
    );
    const text = documentToText(document);
    // The character cue is indented further than the dialogue.
    expect(text).toMatch(/^ {20}JIYEON$/m);
    expect(text).toMatch(/^ {10}Line one$/m);
  });
});
