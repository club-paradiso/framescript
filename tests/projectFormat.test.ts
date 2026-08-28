import { describe, expect, it } from 'vitest';
import { exportScreenplay } from '@/screenplay/export';
import { renderScreenplay } from '@/screenplay/languageRenderer';
import {
  FRAMESCRIPT_PROJECT_FORMAT,
  FRAMESCRIPT_PROJECT_VERSION,
  parseFrameScriptProject,
} from '@/storage/projectFormat';
import type { CharacterEntity } from '@/characters/entities';
import type { Provenance } from '@/evidence/types';
import type { ReconstructedScene } from '@/scenes/types';

const provenance: Provenance = {
  evidenceIds: ['subtitle-1'],
  sources: ['subtitle'],
  confidence: 'high',
  inferred: false,
};

const character: CharacterEntity = {
  id: 'character-1',
  displayName: 'JIYEON',
  aliases: [],
  speakerIds: [],
  visualClusterIds: [],
  confidence: 'high',
  source: 'subtitle',
  lineCount: 1,
};

const scene: ReconstructedScene = {
  id: 'scene-1',
  start: 5_000,
  end: 8_000,
  characters: [{ characterId: character.id, speaks: true, confidence: 'high' }],
  beats: [
    {
      id: 'dialogue-1',
      type: 'dialogue',
      start: 5_000,
      end: 7_500,
      characterId: character.id,
      textVariants: {
        en: {
          language: 'en',
          text: "We're out of milk.",
          origin: 'platform-subtitle',
          confidence: 'high',
        },
      },
      provenance,
    },
  ],
  provenance,
  status: 'finalized',
};

describe('native project format', () => {
  it('round-trips the shared model and truthful diagnostics through JSON export', () => {
    const document = renderScreenplay([scene], { language: 'en', characters: [character] });
    const exported = exportScreenplay(
      document,
      { title: 'Kitchen scene', coverage: ['Observed subtitle range only.'] },
      { format: 'json' },
      {
        scenes: [scene],
        characters: [character],
        languages: ['en'],
        coverage: {
          ratio: 0.75,
          durationMs: 10_000,
          observed: [{ start: 0, end: 7_500 }],
          uncovered: [{ start: 7_500, end: 10_000 }],
          notes: ['Observed subtitle range only.'],
        },
        conflicts: [
          {
            timestamp: 5_000,
            description: 'Subtitle and ASR disagree.',
            evidenceIds: ['subtitle-1', 'asr-1'],
          },
        ],
        sources: [{ name: 'episode.en.srt', kind: 'subtitle', language: 'en' }],
      },
    );

    const parsed = parseFrameScriptProject(JSON.parse(exported.content) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.formatVersion).toBe(FRAMESCRIPT_PROJECT_VERSION);
    expect(parsed.project.scenes[0]?.beats[0]?.provenance).toEqual(provenance);
    expect(parsed.project.coverage.ratio).toBe(0.75);
    expect(parsed.project.conflicts).toHaveLength(1);
    expect(parsed.project.sources[0]?.language).toBe('en');
  });

  it('rejects unknown future versions instead of silently dropping data', () => {
    const parsed = parseFrameScriptProject({
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: FRAMESCRIPT_PROJECT_VERSION + 1,
      scenes: [],
    });
    expect(parsed).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('supports up to') }),
    );
  });

  it('rejects malformed nested screenplay structures', () => {
    const parsed = parseFrameScriptProject({
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: 2,
      metadata: {},
      scenes: [{ id: 'scene-1', start: 0, beats: '<script>alert(1)</script>' }],
      characters: [],
    });
    expect(parsed).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('scenes are malformed'),
      }),
    );
  });

  it('rejects malformed legacy coverage metadata', () => {
    const parsed = parseFrameScriptProject({
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: 1,
      metadata: { coverage: 'not-an-array' },
      scenes: [],
      characters: [],
    });
    expect(parsed).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining('metadata') }),
    );
  });

  it('accepts a structurally valid v1 export with an explicit migration warning', () => {
    const parsed = parseFrameScriptProject({
      format: FRAMESCRIPT_PROJECT_FORMAT,
      formatVersion: 1,
      metadata: { title: 'Legacy project' },
      scenes: [scene],
      characters: [character],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.migratedFrom).toBe(1);
    expect(parsed.warnings[0]).toContain('legacy project format v1');
  });

  it('migrates an extension-saved project through the shared boundary', () => {
    const parsed = parseFrameScriptProject({
      schemaVersion: 1,
      id: 'youtube:abc',
      platform: 'youtube',
      contentId: 'abc',
      title: 'Saved reconstruction',
      languages: ['en'],
      scenes: [scene],
      characters: [character],
      coverage: { observed: [{ start: 0, end: 8_000 }], durationMs: 10_000 },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.project.metadata.platform).toBe('youtube');
    expect(parsed.project.coverage.observed).toEqual([{ start: 0, end: 8_000 }]);
    expect(parsed.project.languages).toEqual(['en']);
  });
});
