import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateScreenplay, MIGRATIONS } from '@/storage/migrations';
import { SCREENPLAY_SCHEMA_VERSION, screenplayId, summarize, type StoredScreenplay } from '@/storage/schema';
import { ScreenplayRepository } from '@/storage/repository';
import { DEFAULT_SETTINGS, describeDataTransmission, mergeSettings, redactSettings } from '@/settings/types';
import { SettingsStore } from '@/settings/store';
import { resetTestStorage } from './setup';

const baseRecord = (): Omit<StoredScreenplay, 'schemaVersion' | 'updatedAt'> => ({
  id: screenplayId('netflix', '81234567'),
  platform: 'netflix',
  contentId: '81234567',
  title: 'Sundae',
  seriesTitle: 'The Bear',
  season: 2,
  episode: 3,
  createdAt: Date.now(),
  coverage: { observed: [{ start: 0, end: 60_000 }], durationMs: 100_000, ratio: 0.6 },
  scenes: [],
  characters: [],
  languageVariants: { platformSubtitles: ['en'], transcribed: [], translated: [] },
});

describe('schema', () => {
  it('builds a deterministic id so re-watching updates one record', () => {
    expect(screenplayId('youtube', 'abc123')).toBe('youtube:abc123');
  });

  it('summarizes a record for the saved list', () => {
    const summary = summarize({ ...baseRecord(), schemaVersion: 2, updatedAt: 1 });
    expect(summary.seriesTitle).toBe('The Bear');
    expect(summary.languages).toEqual(['en']);
    expect(summary.coverageRatio).toBe(0.6);
  });
});

describe('migrations', () => {
  it('leaves a current-version record untouched', () => {
    const record = { ...baseRecord(), schemaVersion: SCREENPLAY_SCHEMA_VERSION, updatedAt: 1 };
    const result = migrateScreenplay(record);
    expect(result?.migrated).toBe(false);
    expect(result?.fromVersion).toBe(SCREENPLAY_SCHEMA_VERSION);
  });

  it('migrates a v1 record and preserves language provenance conservatively', () => {
    const legacy = {
      schemaVersion: 1,
      id: 'youtube:abc',
      platform: 'youtube',
      contentId: 'abc',
      languages: ['en', 'ko'],
      scenes: [],
      characters: [],
      coverage: { observed: [] },
      createdAt: 1,
      updatedAt: 1,
    };
    const result = migrateScreenplay(legacy);

    expect(result?.migrated).toBe(true);
    expect(result?.record.schemaVersion).toBe(2);
    // v1 had no translation feature, so nothing in it can be a translation.
    expect(result?.record.languageVariants.platformSubtitles).toEqual(['en', 'ko']);
    expect(result?.record.languageVariants.translated).toEqual([]);
  });

  it('assumes v1 for a record with no version field', () => {
    const result = migrateScreenplay({ id: 'x', languages: ['en'] });
    expect(result?.fromVersion).toBe(1);
    expect(result?.record.schemaVersion).toBe(2);
  });

  it('refuses a record from a newer version rather than truncating it', () => {
    // Silently dropping fields a future version added would destroy user data.
    expect(migrateScreenplay({ schemaVersion: 999 })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(migrateScreenplay(null)).toBeNull();
    expect(migrateScreenplay('not a record')).toBeNull();
  });

  it('has a migration for every version below the current one', () => {
    for (let version = 1; version < SCREENPLAY_SCHEMA_VERSION; version++) {
      expect(MIGRATIONS[version]).toBeDefined();
    }
  });
});

describe('screenplay repository', () => {
  let repository: ScreenplayRepository;

  beforeEach(() => {
    repository = new ScreenplayRepository();
  });

  it('saves and reads back a screenplay', async () => {
    const saved = await repository.save(baseRecord());
    expect(saved.schemaVersion).toBe(SCREENPLAY_SCHEMA_VERSION);

    const loaded = await repository.get(saved.id);
    expect(loaded?.title).toBe('Sundae');
    expect(loaded?.coverage.ratio).toBe(0.6);
  });

  it('returns null for an unknown id', async () => {
    expect(await repository.get('nothing:here')).toBeNull();
  });

  it('replaces rather than duplicating on re-save', async () => {
    await repository.save(baseRecord());
    await repository.save({ ...baseRecord(), title: 'Updated' });

    const list = await repository.list();
    expect(list.filter((i) => i.contentId === '81234567')).toHaveLength(1);
    expect((await repository.getByContent('netflix', '81234567'))?.title).toBe('Updated');
  });

  it('lists newest first', async () => {
    await repository.save({ ...baseRecord(), id: 'a:1', contentId: '1', title: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repository.save({ ...baseRecord(), id: 'a:2', contentId: '2', title: 'Second' });

    const list = await repository.list();
    expect(list[0]!.title).toBe('Second');
  });

  it('deletes a record', async () => {
    const saved = await repository.save(baseRecord());
    await repository.delete(saved.id);
    expect(await repository.get(saved.id)).toBeNull();
  });

  it('clears everything', async () => {
    await repository.save(baseRecord());
    await repository.clear();
    expect(await repository.list()).toHaveLength(0);
  });
});

describe('settings', () => {
  beforeEach(() => {
    resetTestStorage();
  });

  it('ships with privacy-first defaults', () => {
    // These are the load-bearing defaults for the whole product.
    expect(DEFAULT_SETTINGS.ai.remoteEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.ai.consentAcknowledged).toBe(false);
    expect(DEFAULT_SETTINGS.privacy.retainRawAudio).toBe(false);
    expect(DEFAULT_SETTINGS.privacy.retainRawVideo).toBe(false);
    expect(DEFAULT_SETTINGS.analysis.fidelity).toBe('detailed');
    expect(DEFAULT_SETTINGS.playback.youtubeQuality).toBe('best-available');
  });

  it('merges stored settings over defaults so new keys appear', () => {
    const merged = mergeSettings({ playback: { youtubeQuality: 'max-1080' } } as never);
    expect(merged.playback.youtubeQuality).toBe('max-1080');
    // Untouched keys keep their defaults rather than becoming undefined.
    expect(merged.playback.preferEnhancedBitrate).toBe(true);
    expect(merged.analysis.sources.subtitles).toBe(true);
  });

  it('redacts API keys without revealing whether one is short or long', () => {
    const redacted = redactSettings({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, vision: { ...DEFAULT_SETTINGS.ai.vision, apiKey: 'sk-secret-value' } },
    });
    expect(redacted.ai.vision.apiKey).toBe('<set>');
    expect(redacted.ai.asr.apiKey).toBe('');
  });

  it('states that nothing leaves the device by default', () => {
    const lines = describeDataTransmission(DEFAULT_SETTINGS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No video, audio, subtitles, or viewing data leaves this device');
  });

  it('enumerates exactly what is transmitted when remote AI is on', () => {
    const lines = describeDataTransmission({
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        remoteEnabled: true,
        consentAcknowledged: true,
        vision: { ...DEFAULT_SETTINGS.ai.vision, provider: 'anthropic', apiKey: 'k' },
        asr: { ...DEFAULT_SETTINGS.ai.asr, provider: 'openai-compatible', apiKey: 'k' },
      },
    });
    expect(lines.some((l) => l.includes('keyframes'))).toBe(true);
    expect(lines.some((l) => l.includes('audio windows'))).toBe(true);
    // And it always names what is never sent.
    expect(lines.some((l) => l.includes('Never sent'))).toBe(true);
  });

  it('persists and reloads through the store', async () => {
    const store = new SettingsStore();
    await store.update({ analysis: { fidelity: 'forensic' } });

    const reloaded = new SettingsStore();
    expect((await reloaded.get()).analysis.fidelity).toBe('forensic');
  });

  it('applies a nested patch without discarding siblings', async () => {
    const store = new SettingsStore();
    await store.update({ analysis: { sources: { video: false } } });
    const settings = await store.get();

    expect(settings.analysis.sources.video).toBe(false);
    expect(settings.analysis.sources.subtitles).toBe(true);
    expect(settings.analysis.fidelity).toBe('detailed');
  });

  it('notifies subscribers of updates', async () => {
    const store = new SettingsStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.analysis.fidelity));
    await store.update({ analysis: { fidelity: 'efficient' } });
    unsubscribe();
    expect(seen).toContain('efficient');
  });

  it('resets to defaults', async () => {
    const store = new SettingsStore();
    await store.update({ analysis: { fidelity: 'forensic' } });
    const reset = await store.reset();
    expect(reset.analysis.fidelity).toBe('detailed');
  });
});
