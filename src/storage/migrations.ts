/**
 * Schema migrations.
 *
 * Records written by an older FrameScript must keep opening. Each migration is
 * a pure function from one version to the next, so the chain can be tested
 * without a database.
 */

import { SCREENPLAY_SCHEMA_VERSION, type StoredScreenplay } from './schema';

export type MigrationFn = (record: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version being migrated *from*. */
export const MIGRATIONS: Record<number, MigrationFn> = {
  /**
   * v1 -> v2: language tracking split into three lists.
   *
   * v1 stored a flat `languages: string[]`, which lost the distinction between
   * a real platform subtitle and an AI translation — a distinction the product
   * now treats as load-bearing. Unknown provenance migrates to
   * `platformSubtitles`, the conservative choice, because v1 had no translation
   * feature and therefore could not contain translated text.
   */
  1: (record) => {
    const legacy = Array.isArray(record.languages) ? (record.languages as string[]) : [];
    const existing = record.languageVariants as Record<string, unknown> | undefined;
    return {
      ...record,
      languageVariants: {
        platformSubtitles: (existing?.platformSubtitles as string[]) ?? legacy,
        transcribed: (existing?.transcribed as string[]) ?? [],
        translated: (existing?.translated as string[]) ?? [],
      },
      schemaVersion: 2,
    };
  },
};

export interface MigrationResult {
  record: StoredScreenplay;
  migrated: boolean;
  fromVersion: number;
}

/**
 * Brings a record up to the current version.
 *
 * Records from a *newer* version than this build understands are rejected
 * rather than truncated: silently dropping fields a future version added would
 * destroy the user's data on downgrade.
 */
export function migrateScreenplay(raw: unknown): MigrationResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = { ...(raw as Record<string, unknown>) };
  const fromVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : 1;

  if (fromVersion > SCREENPLAY_SCHEMA_VERSION) return null;
  if (fromVersion === SCREENPLAY_SCHEMA_VERSION) {
    return { record: record as unknown as StoredScreenplay, migrated: false, fromVersion };
  }

  let current = record;
  let version = fromVersion;
  while (version < SCREENPLAY_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return null;
    current = migrate(current);
    const next = typeof current.schemaVersion === 'number' ? current.schemaVersion : version + 1;
    if (next <= version) return null;
    version = next;
  }

  return { record: current as unknown as StoredScreenplay, migrated: true, fromVersion };
}
