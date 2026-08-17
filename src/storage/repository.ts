/**
 * IndexedDB screenplay repository.
 *
 * `chrome.storage` is the wrong tool for this data: a feature-length screenplay
 * with provenance runs to megabytes, and chrome.storage.local is a
 * serialize-the-whole-value store. IndexedDB gives per-record reads and writes
 * and an index for the "saved scripts" list.
 */

import { FrameScriptError } from '../utils/errors';
import { migrateScreenplay } from './migrations';
import { SCREENPLAY_SCHEMA_VERSION, screenplayId, summarize } from './schema';
import type { ScreenplaySummary, StoredScreenplay } from './schema';

const DB_NAME = 'framescript';
const DB_VERSION = 1;
const STORE = 'screenplays';
const INDEX_UPDATED = 'updatedAt';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'IndexedDB unavailable' }));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(INDEX_UPDATED, 'updatedAt', { unique: false });
        store.createIndex('contentId', 'contentId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'failed to open database', cause: request.error }));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'request failed', cause: request.error }));
  });
}

export class ScreenplayRepository {
  #db: Promise<IDBDatabase> | null = null;

  #database(): Promise<IDBDatabase> {
    this.#db ??= openDatabase();
    return this.#db;
  }

  /** Saves or replaces a screenplay. Always stamps the current schema version. */
  async save(record: Omit<StoredScreenplay, 'schemaVersion' | 'updatedAt'>): Promise<StoredScreenplay> {
    const db = await this.#database();
    const full: StoredScreenplay = {
      ...record,
      schemaVersion: SCREENPLAY_SCHEMA_VERSION,
      updatedAt: Date.now(),
    };
    const tx = db.transaction(STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE).put(full));
    await transactionDone(tx);
    return full;
  }

  async get(id: string): Promise<StoredScreenplay | null> {
    const db = await this.#database();
    const tx = db.transaction(STORE, 'readonly');
    const raw = await promisifyRequest(tx.objectStore(STORE).get(id));
    if (!raw) return null;

    const migrated = migrateScreenplay(raw);
    if (!migrated) {
      // Written by a newer FrameScript, or corrupt. Refuse rather than mangle.
      console.warn(`[FrameScript] cannot read screenplay ${id}: unsupported schema`);
      return null;
    }
    // Opportunistically persist the upgrade so the cost is paid once.
    if (migrated.migrated) await this.save(migrated.record);
    return migrated.record;
  }

  async getByContent(platform: string, contentId: string): Promise<StoredScreenplay | null> {
    return this.get(screenplayId(platform, contentId));
  }

  async list(limit = 100): Promise<ScreenplaySummary[]> {
    const db = await this.#database();
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index(INDEX_UPDATED);

    const summaries: ScreenplaySummary[] = [];
    await new Promise<void>((resolve, reject) => {
      // 'prev' walks newest-first, so `limit` gives the most recent records.
      const request = index.openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || summaries.length >= limit) {
          resolve();
          return;
        }
        const migrated = migrateScreenplay(cursor.value);
        if (migrated) summaries.push(summarize(migrated.record));
        cursor.continue();
      };
      request.onerror = () =>
        reject(new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'list failed', cause: request.error }));
    });
    return summaries;
  }

  async delete(id: string): Promise<void> {
    const db = await this.#database();
    const tx = db.transaction(STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE).delete(id));
    await transactionDone(tx);
  }

  /** Deletes every saved screenplay. Exposed in Settings → Storage. */
  async clear(): Promise<void> {
    const db = await this.#database();
    const tx = db.transaction(STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(STORE).clear());
    await transactionDone(tx);
  }

  /** Approximate bytes used, for the storage panel. */
  async estimateSize(): Promise<number> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return 0;
    const estimate = await navigator.storage.estimate();
    return estimate.usage ?? 0;
  }

  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = null;
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(new FrameScriptError({ code: 'STORAGE_FAILED', detail: 'transaction failed', cause: tx.error }));
  });
}

export const screenplayRepository = new ScreenplayRepository();
