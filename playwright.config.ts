import { defineConfig } from '@playwright/test';

/**
 * Extension end-to-end tests.
 *
 * Chrome extensions cannot be loaded in a normal browser context — they need a
 * *persistent* context launched with `--load-extension`, and they only work
 * headed (or in the new headless mode). Each spec launches its own context, so
 * there is no global `use.browserName` here.
 *
 * These tests verify that the built extension loads, that its surfaces render,
 * and that settings round-trip. They deliberately do NOT drive YouTube or
 * Netflix: automating a real streaming session is unreliable in CI, and
 * FrameScript's platform logic is covered by the jsdom fixture tests instead.
 * Live-site verification is a manual pass — see docs/QA.md.
 */
export default defineConfig({
  // Both suites launch their own browser context; extension tests need a
  // persistent context, and the web tests only need a page.
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'e2e-web/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
