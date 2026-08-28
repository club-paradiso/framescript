/** Production-build user journeys for FrameScript Web Studio. */

import { expect, test, chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist-web', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function serve(root: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      const relative = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+/, '');
      let filePath = join(root, relative === '/' ? 'index.html' : relative);
      if (!existsSync(filePath)) filePath = join(root, 'index.html');
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, {
          'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

const EN_SRT = `1
00:00:05,000 --> 00:00:07,500
JIYEON: We're out of milk.

2
00:00:08,000 --> 00:00:10,000
[refrigerator door closes]

3
00:00:11,200 --> 00:00:13,800
DANIEL: I'll go get some.

4
00:00:30,000 --> 00:00:33,000
JIYEON: Take an umbrella.
`;

const KO_SRT = `1
00:00:05,000 --> 00:00:07,500
지연: 우유가 없네.

2
00:00:11,200 --> 00:00:13,800
다니엘: 내가 사올게.

3
00:00:30,000 --> 00:00:33,000
지연: 우산 챙겨.
`;

let browser: Browser;
let server: Server;
let origin: string;
let page: Page;

test.beforeAll(async () => {
  if (!existsSync(DIST)) throw new Error('dist-web/ not found — run `npm run build:web` first.');
  ({ server, origin } = await serve(DIST));
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
    args: ['--no-sandbox'],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test.beforeEach(async () => {
  page = await browser.newPage();
});

test.afterEach(async () => page?.close());

async function openStudio(path = '/studio') {
  await page.goto(origin + path);
  await expect(
    page.getByRole('heading', { name: /Drop files|Open a FrameScript project/ }),
  ).toBeVisible();
}

async function upload(files: { name: string; buffer: Buffer; mimeType?: string }[]) {
  await page.setInputFiles(
    '#framescript-file-input',
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType ?? 'text/plain',
      buffer: file.buffer,
    })),
  );
}

test('landing page explains the product, privacy, and extension boundary', async () => {
  await page.goto(origin + '/');
  await expect(
    page.getByRole('heading', { name: /Turn video into a structured screenplay/i }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Open Studio/i }).first()).toHaveAttribute(
    'href',
    '/studio',
  );
  await expect(page.getByText(/Your media stays local/i)).toBeVisible();
  await expect(
    page.getByText(/Live YouTube and Netflix playback requires the Chrome Extension/i),
  ).toBeVisible();
  await expect(page.getByText(/Every screenplay beat retains its sources/i)).toBeVisible();
});

test('direct navigation to every public app route works', async () => {
  await openStudio();
  await page.goto(origin + '/view');
  await expect(page.getByRole('heading', { name: 'Open a FrameScript project.' })).toBeVisible();
  await page.goto(origin + '/docs');
  await expect(page.getByRole('heading', { name: 'FrameScript documentation' })).toBeVisible();
});

test('installs an offline shell without caching user files', async () => {
  await openStudio();
  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const requests = (
      await Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))
    ).flat();
    return {
      scope: registration.scope,
      keys,
      cachedUrls: requests.map((request) => request.url),
    };
  });
  expect(state.scope).toBe(origin + '/');
  expect(state.keys).toContain('framescript-studio-v3');
  expect(state.cachedUrls.every((url) => !url.startsWith('blob:'))).toBe(true);

  await page.context().setOffline(true);
  try {
    await page.goto(origin + '/studio');
    await expect(
      page.getByRole('heading', { name: 'Drop files. Build the script.' }),
    ).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test('uploads subtitles, reconstructs a navigable screenplay, and shows honest coverage', async () => {
  await openStudio();
  await upload([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  await expect(page.locator('.line__text', { hasText: "We're out of milk." })).toBeVisible();
  await expect(page.getByText('Refrigerator door closes.')).toBeVisible();
  await expect(page.getByText('4 cues · SRT')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Scenes' }).locator('li')).toHaveCount(2);

  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.getByText('100% observed')).toBeVisible();
  await expect(
    page.getByText(/measures observed ranges, not screenplay completeness/i),
  ).toBeVisible();
});

test('aligns EN and KO into shared scenes and switches to dual-language display', async () => {
  await openStudio();
  await upload([
    { name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) },
    { name: 'demo.ko.srt', buffer: Buffer.from(KO_SRT) },
  ]);

  await page.getByLabel('Script language').selectOption('ko');
  await page.getByLabel('Second language').selectOption('en');
  const dialogue = page.locator('.line--dialogue').first();
  await expect(dialogue.locator('.line__text')).toHaveText('우유가 없네.');
  await expect(dialogue.locator('.line__secondary')).toHaveText("We're out of milk.");
  await expect(page.getByRole('navigation', { name: 'Scenes' }).locator('li')).toHaveCount(2);
});

test('searches every language and navigates from a result to its scene', async () => {
  await openStudio();
  await upload([
    { name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) },
    { name: 'demo.ko.srt', buffer: Buffer.from(KO_SRT) },
  ]);

  await page.getByLabel('Search screenplay').fill('우산');
  await expect(page.getByText('1 match')).toBeVisible();
  await page.locator('.result').click();
  await expect(page.getByLabel('Search screenplay')).toHaveValue('');
  await expect(page.locator('.line__text', { hasText: 'Take an umbrella.' })).toBeVisible();
});

test('exposes evidence provenance without replacing the readable screenplay', async () => {
  await openStudio();
  await upload([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);
  await expect(page.getByText('Subtitle').first()).toBeVisible();
  await page.locator('.script-toolbar').getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.locator('.evidence__confidence').first()).toHaveText('high');
  await expect(page.getByText('observed').first()).toBeVisible();
});

test('exports and reopens a versioned native project', async () => {
  await openStudio();
  await upload([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Export format').selectOption('json');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export en' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('demo.en.json');
  const savedPath = await file.path();
  expect(savedPath).not.toBeNull();

  const content = readFileSync(savedPath!);
  const json = JSON.parse(content.toString()) as Record<string, unknown>;
  expect(json.format).toBe('framescript-screenplay');
  expect(json.formatVersion).toBe(2);
  expect(json.scenes).toBeInstanceOf(Array);
  expect(json.coverage).toBeTruthy();

  await page.goto(origin + '/view');
  await upload([{ name: 'demo.framescript.json', mimeType: 'application/json', buffer: content }]);
  await expect(page.locator('.line__text', { hasText: "We're out of milk." })).toBeVisible();
  await expect(page.getByText(/format v2/i)).toBeVisible();
});

test('rejects malformed and unsupported input, then remains usable', async () => {
  await openStudio();
  await upload([{ name: 'junk.srt', buffer: Buffer.from('not a subtitle file') }]);
  await expect(page.getByText(/No subtitle cues found/i)).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(page.getByText(/No subtitle cues found/i)).toHaveCount(0);

  await upload([{ name: 'payload.exe', buffer: Buffer.from('MZ') }]);
  await expect(page.getByText(/payload\.exe is unsupported/i)).toBeVisible();

  await upload([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);
  await expect(page.locator('.line__text', { hasText: "We're out of milk." })).toBeVisible();
});

test('detects duplicate inputs and escapes subtitle text', async () => {
  await openStudio();
  const unsafe = EN_SRT.replace("We're out of milk.", '<img src=x onerror=window.pwned=true>');
  await upload([{ name: 'unsafe.en.srt', buffer: Buffer.from(unsafe) }]);
  await expect(
    page.locator('.line__text', { hasText: '<img src=x onerror=window.pwned=true>' }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).not.toBe(
    true,
  );

  await upload([{ name: 'unsafe.en.srt', buffer: Buffer.from(unsafe) }]);
  await expect(page.getByText(/already loaded; the duplicate was skipped/i)).toBeVisible();
});

test('keeps intake, navigation, inspection and export usable at 390px', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio();
  await upload([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  await page.getByRole('tab', { name: 'Scenes' }).click();
  await expect(page.getByRole('navigation', { name: 'Scenes' })).toBeVisible();
  await page.getByRole('tab', { name: 'Evidence', exact: true }).first().click();
  await expect(page.getByLabel('Project inspector')).toBeVisible();
  await page.getByRole('tab', { name: 'Script' }).click();
  await expect(page.getByLabel('Screenplay', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export en' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('analyzes deterministic local audio without uploading it', async () => {
  await openStudio();
  const wav = readFileSync(
    fileURLToPath(new URL('../tests/fixtures/fixture-speech.wav', import.meta.url)),
  );
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await upload([{ name: 'fixture-speech.wav', mimeType: 'audio/wav', buffer: wav }]);

  const analyzer = page.locator('.card', { hasText: 'Analyze media' });
  await expect(analyzer.getByText('fixture-speech.wav')).toBeVisible();
  // This build serves no /api routes, so the capability readout must say so
  // rather than offering a control that cannot work.
  await expect(analyzer.locator('.capability', { hasText: 'Transcription' })).toContainText(
    'Not configured',
  );
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(analyzer.getByText('Analysis complete')).toBeVisible({ timeout: 45_000 });
  await expect(analyzer.getByText('2 speech regions')).toBeVisible();
  await expect(analyzer.getByText('2 speaker clusters')).toBeVisible();
  expect(requests.every((url) => url.startsWith(origin) || url.startsWith('blob:'))).toBe(true);
});

test('ships no provider credential, endpoint or auth header in the client bundle', () => {
  // Studio talks only to its own origin. Anything below appearing in the bundle
  // would mean a provider call had leaked back into the browser, taking the
  // key or the endpoint with it.
  const forbidden = [
    'FRAMESCRIPT_ASR_API_KEY',
    'FRAMESCRIPT_VISION_API_KEY',
    'FRAMESCRIPT_ASR_ENDPOINT',
    'FRAMESCRIPT_VISION_ENDPOINT',
    'api.openai.com',
    'api.anthropic.com',
    'anthropic-version',
    'x-api-key',
    'audio/transcriptions',
    'process.env',
    'import.meta.env.VITE_',
  ];

  const assets = join(DIST, 'assets');
  const files = readdirSync(assets).filter((name) => name.endsWith('.js') || name.endsWith('.css'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    const contents = readFileSync(join(assets, name), 'utf8');
    for (const marker of forbidden) {
      expect(contents, `${name} must not contain "${marker}"`).not.toContain(marker);
    }
  }

  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  for (const marker of forbidden) expect(html).not.toContain(marker);
});
