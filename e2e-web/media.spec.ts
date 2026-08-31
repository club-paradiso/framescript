/**
 * The critical acceptance path: a subtitle-free MP4 becomes a screenplay with
 * transcription-backed dialogue.
 *
 * Everything here runs against the production build, the real API routes and a
 * real encoded MP4 that this browser produced and this browser decodes. The
 * only substitution is the transcription provider itself.
 *
 * Note on codecs: an open-source Chromium build ships without H.264 and AAC, so
 * the clip is recorded with whatever the browser under test can encode into an
 * MP4 container. The container, the demux, `decodeAudioData`, playback, canvas
 * readback, VAD, diarization, the WAV framing, the API round trip, the evidence
 * mapping and the reconstruction are all identical either way — the codec is
 * the browser's business, and the test states which one it got.
 */

import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  configureTranscription,
  configureVision,
  startProviderStub,
  startStudio,
  startVisionStub,
  unconfigureProviders,
  type ProviderStub,
  type StudioServer,
  type VisionStub,
} from './harness';
import { isMp4, recordSyntheticClip, type SyntheticClip } from './synthetic-media';

let browser: Browser;
let studio: StudioServer;
let provider: ProviderStub;
let vision: VisionStub;
let page: Page;
let clip: SyntheticClip;

const ANALYSIS_TIMEOUT = 150_000;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  provider = await startProviderStub();
  vision = await startVisionStub();
  studio = await startStudio();
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  // Record the clip once: it takes its own runtime in real time.
  const recorder = await browser.newPage();
  await recorder.goto(studio.origin + '/studio');
  clip = await recordSyntheticClip(recorder, { durationSeconds: 12 });
  await recorder.close();

  expect(clip.bytes.byteLength).toBeGreaterThan(1_000);
  console.log(
    `synthetic clip: ${clip.mimeType}, ${(clip.bytes.byteLength / 1024).toFixed(0)} KB, MP4 container: ${isMp4(clip)}`,
  );
});

test.afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await provider?.close();
  await vision?.close();
  unconfigureProviders();
});

test.beforeEach(async () => {
  provider.reset();
  vision.reset();
  studio.apiRequests.length = 0;
  page = await browser.newPage();
});

test.afterEach(async () => {
  await page?.close();
  unconfigureProviders();
});

async function openStudioWithClip(): Promise<string[]> {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(studio.origin) && !request.url().startsWith('blob:')) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(studio.origin + '/studio');
  await page.setInputFiles('#framescript-file-input', [
    { name: 'scene.mp4', mimeType: 'video/mp4', buffer: clip.bytes },
  ]);
  await expect(page.locator('.card', { hasText: 'Analyze media' })).toBeVisible();
  return externalRequests;
}

const analyzer = () => page.locator('.card', { hasText: 'Analyze media' });
/** The counted, measured result block — never the surrounding explanatory copy. */
const summary = () => analyzer().locator('.analysis-summary');

test('reports transcription as unavailable when the deployment has no provider', async () => {
  await openStudioWithClip();

  const capability = analyzer().locator('.capability', { hasText: 'Transcription' });
  await expect(capability).toContainText('Not configured');
  await expect(analyzer().getByText(/no transcription provider configured/i)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Transcribe detected speech/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  // Local structural evidence still arrives, and no dialogue is invented.
  await expect(summary().getByText(/speech regions/)).toBeVisible();
  await expect(summary().getByText(/shot cuts/)).toBeVisible();
  expect(await page.locator('.line--dialogue').count()).toBe(0);
});

test('transcribes a subtitle-free MP4 into attributed screenplay dialogue', async () => {
  configureTranscription(provider);
  const externalRequests = await openStudioWithClip();

  const capability = analyzer().locator('.capability', { hasText: 'Transcription' });
  await expect(capability).toContainText('Ready');
  await expect(capability).toContainText('stub-whisper');

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();

  // The phases are named, not a single opaque bar.
  await expect(analyzer().getByText('Decoding audio')).toBeVisible({ timeout: 30_000 });
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  // 1-8: metadata, audio decode, speech regions, speakers, transcription,
  // picture scan and shot cuts — all reported as measured counts.
  await expect(analyzer().getByText(/\d+ speech regions/)).toBeVisible();
  await expect(analyzer().getByText(/\d+ speaker clusters/)).toBeVisible();
  await expect(summary().getByText(/transcribed dialogue segments/)).toBeVisible();
  await expect(summary().getByText(/picture observations/)).toBeVisible();

  // 9-11: the deterministic engine turned that evidence into dialogue.
  expect(provider.calls).toBeGreaterThanOrEqual(2);
  const dialogue = page.locator('.line--dialogue');
  await expect(dialogue.first()).toBeVisible();
  expect(await dialogue.count()).toBe(provider.transcripts.length);
  await expect(dialogue.first().locator('.line__text')).toContainText('Transcribed dialogue line');

  // Attributed to an anonymous cluster, never to an invented name.
  const cue = page.locator('.line--character').first();
  await expect(cue).toHaveText(/SPEAKER \d+|UNKNOWN SPEAKER/);

  // 12: provenance survives into the evidence view.
  await page.locator('.script-toolbar').getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.getByText('Audio asr').first()).toBeVisible();

  // 15: the video itself never left the page. Only speech windows did.
  expect(externalRequests).toEqual([]);
  expect(studio.apiRequests.filter((entry) => entry === 'POST /api/transcribe').length).toBe(
    provider.calls,
  );
});

test('exports the transcribed screenplay', async () => {
  configureTranscription(provider);
  await openStudioWithClip();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
  await expect(page.locator('.line--dialogue').first()).toBeVisible();

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export / }).click();
  const file = await download;
  const savedPath = await file.path();
  expect(savedPath).not.toBeNull();
  expect(readFileSync(savedPath!, 'utf8')).toContain('Transcribed dialogue line');
});

test('keeps every other source when the provider rate limits the run', async () => {
  configureTranscription(provider);
  provider.mode = 'rate-limited';
  await openStudioWithClip();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  // The failure is named, and the run is not stuck or discarded.
  await expect(summary().getByText(/rate limiting this analysis/i)).toBeVisible();
  await expect(analyzer().getByText(/\d+ speech regions/)).toBeVisible();
  await expect(summary().getByText(/shot cuts/)).toBeVisible();
  expect(await page.locator('.line--dialogue').count()).toBe(0);

  // It gave up rather than retrying into the wall for every window.
  expect(provider.calls).toBeLessThan(20);
});

test('surfaces a provider outage without losing local analysis', async () => {
  configureTranscription(provider);
  provider.mode = 'server-error';
  await openStudioWithClip();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
  await expect(summary().getByText(/transcription service could not complete/i)).toBeVisible();
  await expect(analyzer().getByText(/\d+ speaker clusters/)).toBeVisible();
});

test('stops cleanly when the run is cancelled', async () => {
  configureTranscription(provider);
  await openStudioWithClip();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(summary().getByText('Analysis stopped')).toBeVisible({ timeout: 30_000 });
  // Not stuck in "Analyzing", and re-runnable.
  await expect(page.getByRole('button', { name: 'Analyze again' })).toBeEnabled();
  const stillPlaying = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.analyzer__video');
    return video ? !video.paused : false;
  });
  expect(stillPlaying).toBe(false);
});

test('produces a sanitized diagnostics report', async () => {
  configureTranscription(provider);
  await openStudioWithClip();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.getByRole('button', { name: 'Diagnostics copied' })).toBeVisible();

  const report = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(report) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    file: { name: 'scene.mp4' },
    configuration: { transcription: { configured: true, model: 'stub-whisper' } },
  });
  expect(report).not.toContain('Transcribed dialogue line');
  expect(report).not.toContain('e2e-test-key');
  expect(report).not.toContain('127.0.0.1');
});

test('analyzes and reads the transcribed script at 390px', async () => {
  configureTranscription(provider);
  await page.setViewportSize({ width: 390, height: 844 });

  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(studio.origin) && !request.url().startsWith('blob:')) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(studio.origin + '/studio');
  await page.setInputFiles('#framescript-file-input', [
    { name: 'scene.mp4', mimeType: 'video/mp4', buffer: clip.bytes },
  ]);

  // On a phone the workspace is tabbed, and the analyzer lives beside the
  // scene list rather than under the script.
  await page.getByRole('tab', { name: 'Scenes' }).click();
  await expect(analyzer()).toBeVisible();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  await page.getByRole('tab', { name: 'Script' }).click();
  await expect(page.locator('.line--dialogue').first()).toBeVisible();
  expect(externalRequests).toEqual([]);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('never lets the service worker cache an analysis request', async () => {
  configureTranscription(provider);
  await openStudioWithClip();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = (
      await Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))
    ).flat();
    return requests.map((request) => request.url);
  });
  expect(cached.some((url) => url.includes('/api/'))).toBe(false);
  expect(cached.some((url) => url.startsWith('blob:'))).toBe(false);
});

test('describes selected scenes without sending the video, and bounds the requests', async () => {
  configureTranscription(provider);
  configureVision(vision);
  const externalRequests = await openStudioWithClip();

  await expect(
    analyzer().locator('.capability', { hasText: 'Visual understanding' }),
  ).toContainText('Ready');
  await expect(page.getByLabel('Scene understanding')).toHaveValue('key');
  await expect(analyzer().getByText(/At most 6 requests for this file/)).toBeVisible();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  // A description the local scanner could not have produced, in the script.
  expect(vision.calls).toBeGreaterThan(0);
  expect(vision.calls).toBeLessThanOrEqual(6);
  await expect(summary().getByText(/semantic scene observations/)).toBeVisible();
  await expect(
    page.locator('.line--action', { hasText: 'pale block slides across the frame' }).first(),
  ).toBeVisible();

  // Each request carried a handful of keyframes, never a frame stream.
  expect(vision.frameCounts.length).toBe(vision.calls);
  for (const count of vision.frameCounts) {
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(3);
  }
  expect(externalRequests).toEqual([]);
});

test('turning scene understanding off makes no vision request at all', async () => {
  configureTranscription(provider);
  configureVision(vision);
  await openStudioWithClip();
  await page.getByLabel('Scene understanding').selectOption('off');

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  expect(vision.calls).toBe(0);
  await expect(summary().getByText(/semantic scene observations/)).toHaveCount(0);
});

test('keeps the transcript when scene understanding fails', async () => {
  configureTranscription(provider);
  configureVision(vision);
  vision.mode = 'server-error';
  await openStudioWithClip();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(summary().getByText('Analysis complete')).toBeVisible({ timeout: ANALYSIS_TIMEOUT });

  await expect(
    summary().getByText(/scene-understanding service could not complete/i),
  ).toBeVisible();
  await expect(page.locator('.line--dialogue').first()).toBeVisible();
});
