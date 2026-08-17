/**
 * Vitest setup.
 *
 * Provides the minimal `chrome` surface the modules under test touch, so that
 * pure logic can be tested without a browser. Anything not stubbed here is a
 * deliberate signal that a test is reaching into extension APIs it should not.
 */
import { vi } from 'vitest';

const storage = new Map<string, unknown>();

const chromeStub = {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[] | null) => {
        if (key === null || key === undefined) return Object.fromEntries(storage);
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) if (storage.has(k)) out[k] = storage.get(k);
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, value] of Object.entries(items)) storage.set(k, value);
      }),
      remove: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
      clear: vi.fn(async () => storage.clear()),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    id: 'framescript-test',
    lastError: undefined,
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    getURL: (path: string) => `chrome-extension://framescript-test/${path}`,
  },
};

Object.defineProperty(globalThis, 'chrome', { value: chromeStub, writable: true, configurable: true });

export function resetTestStorage(): void {
  storage.clear();
}
