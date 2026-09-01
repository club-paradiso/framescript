/**
 * Verifies that the built extension actually loads in Chrome and that its
 * surfaces render. This is the check the unit suite structurally cannot make:
 * a valid manifest, resolvable asset paths, a service worker that registers,
 * and React roots that mount.
 */

import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_PATH = fileURLToPath(new URL('../dist', import.meta.url));

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error('dist/ not found — run `npm run build` before the e2e suite.');
  }

  userDataDir = mkdtempSync(join(tmpdir(), 'framescript-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // `PLAYWRIGHT_CHROMIUM_EXECUTABLE` lets an environment that already ships a
    // Chromium build point at it instead of downloading a matching revision.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: 'chromium' }),
    args: [
      // Extensions require the new headless mode; the old one cannot load them.
      '--headless=new',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
  });

  // The service worker registers shortly after launch.
  let worker: Worker | undefined = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('the service worker registers', () => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test('tab capture is requested by the service worker, not a transient UI page', () => {
  const worker = readFileSync(join(EXTENSION_PATH, 'background/serviceWorker.js'), 'utf8');
  const popup = readFileSync(join(EXTENSION_PATH, 'assets/popup.js'), 'utf8');
  const sidePanel = readFileSync(join(EXTENSION_PATH, 'assets/sidepanel.js'), 'utf8');

  expect(worker).toContain('getMediaStreamId');
  expect(popup).not.toContain('getMediaStreamId');
  expect(sidePanel).not.toContain('getMediaStreamId');
});

test('the popup renders and offers to open the screenplay', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);

  // The wordmark appears once; `getByText` would also match its container.
  await expect(page.locator('.fs-wordmark')).toBeVisible();
  // Off a supported site, the popup explains itself rather than showing controls.
  await expect(page.getByText(/works on YouTube and Netflix/i)).toBeVisible();
  await page.close();
});

test('the side panel renders its empty state', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);

  await expect(page.locator('.fs-wordmark')).toBeVisible();
  await expect(page.getByText(/Open a video on YouTube or Netflix/i)).toBeVisible();
  // The core promise is stated up front, including that nothing runs unasked.
  await expect(page.getByText(/Nothing is analyzed until you start it/i)).toBeVisible();
  await page.close();
});

test('the options page renders every section', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  for (const section of ['Playback', 'Analysis', 'Languages', 'AI', 'Privacy', 'Advanced']) {
    await expect(page.getByRole('button', { name: section, exact: true })).toBeVisible();
  }
  await page.close();
});

test('remote AI is off by default and gated behind consent', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.getByRole('button', { name: 'AI', exact: true }).click();

  // The shipped default: nothing leaves the device.
  await expect(page.getByText(/No video, audio, subtitles, or viewing data leaves this device/i)).toBeVisible();

  const enable = page.getByRole('checkbox', { name: /Enable remote AI/i });
  await expect(enable).not.toBeChecked();
  await expect(enable).toBeDisabled();

  // Acknowledging the notice is what unlocks the toggle.
  await page.getByRole('checkbox', { name: /I understand what is transmitted/i }).check();
  await expect(enable).toBeEnabled();
  await page.close();
});

test('settings persist across a reload', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.getByRole('button', { name: 'Analysis', exact: true }).click();

  await page.getByRole('radio', { name: /Efficient/i }).check();
  await page.reload();
  await page.getByRole('button', { name: 'Analysis', exact: true }).click();

  await expect(page.getByRole('radio', { name: /Efficient/i })).toBeChecked();
  await page.close();
});

test('the privacy section states the defaults plainly', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();

  await expect(page.getByText('Analytics')).toBeVisible();
  await expect(page.getByText(/no code path in FrameScript that writes media to disk/i)).toBeVisible();
  await page.close();
});
