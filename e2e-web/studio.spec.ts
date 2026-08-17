/**
 * FrameScript Studio end-to-end tests.
 *
 * Drives the built PWA in a real browser with real subtitle files, verifying
 * the whole path: file intake -> parsing -> reconstruction -> rendering ->
 * search -> export. This is the check the unit suite cannot make, because it
 * exercises the File API, the object-URL download path, and the shared engine
 * running in a browser rather than in Node.
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

const DIST = fileURLToPath(new URL('../dist-web', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * A tiny static server.
 *
 * The app is served over HTTP rather than file:// because a file:// origin is
 * opaque, which breaks module loading and the service worker — neither of
 * which is a real property of the app.
 */
function serve(root: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      const relative = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+/, '');
      let filePath = join(root, relative === '/' ? 'index.html' : relative);
      if (!existsSync(filePath)) filePath = join(root, 'index.html');
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
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
  await page.goto(origin);
});

test.afterEach(async () => page?.close());

async function drop(files: { name: string; buffer: Buffer }[]) {
  await page.setInputFiles(
    '#framescript-file-input',
    files.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: f.buffer })),
  );
}

test('states plainly that it cannot analyze YouTube or Netflix', async () => {
  await expect(page.getByRole('heading', { name: 'What this cannot do' })).toBeVisible();
  await expect(page.getByText(/cannot analyze YouTube or Netflix/i)).toBeVisible();
  await expect(page.getByText(/FrameScript browser extension/i)).toBeVisible();
});

test('reconstructs a screenplay from a subtitle file', async () => {
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  // Speaker labels became character cues, not dialogue text.
  await expect(page.getByText('JIYEON').first()).toBeVisible();
  await expect(page.getByText("We're out of milk.")).toBeVisible();
  // A bracketed caption became a sound beat, not a spoken line.
  await expect(page.getByText('Refrigerator door closes.')).toBeVisible();

  await expect(page.getByText('4 cues · SRT')).toBeVisible();
});

test('reports reconstruction statistics', async () => {
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  const stats = page.locator('.stats');
  await expect(stats.getByText('Dialogue')).toBeVisible();
  // Three spoken lines and one sound beat, from four cues.
  await expect(stats.locator('.stats__item', { hasText: 'Dialogue' }).locator('dd')).toHaveText('3');
  await expect(stats.locator('.stats__item', { hasText: 'Sound' }).locator('dd')).toHaveText('1');
  await expect(stats.locator('.stats__item', { hasText: 'Speakers' }).locator('dd')).toHaveText('2');
});

test('reports 100% coverage for a complete subtitle file', async () => {
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);
  // The gaps between cues were observed; they simply had no dialogue.
  await expect(page.getByText(/100% of the media was observed/)).toBeVisible();
});

test('merges two languages into one dual-language script', async () => {
  await drop([
    { name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) },
    { name: 'demo.ko.srt', buffer: Buffer.from(KO_SRT) },
  ]);

  await page.getByLabel('Script language').selectOption('ko');
  await page.getByLabel('Second language').selectOption('en');

  // One beat carrying both variants, not two separate beats.
  const dialogue = page.locator('.line--dialogue').first();
  await expect(dialogue.locator('.line__text')).toHaveText('우유가 없네.');
  await expect(dialogue.locator('.line__secondary')).toHaveText("We're out of milk.");
});

test('warns when a filename carries no language marker', async () => {
  await drop([{ name: 'nomarker.srt', buffer: Buffer.from(EN_SRT) }]);
  await expect(page.getByText(/No language marker in the filename/i)).toBeVisible();
});

test('searches across every loaded language', async () => {
  await drop([
    { name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) },
    { name: 'demo.ko.srt', buffer: Buffer.from(KO_SRT) },
  ]);

  await page.getByLabel('Search').fill('우산');
  await expect(page.getByText('1 match')).toBeVisible();
  await expect(page.locator('.result mark')).toHaveText('우산');
});

test('shows evidence provenance in the Evidence view', async () => {
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);
  await page.getByRole('tab', { name: 'Evidence' }).click();

  await expect(page.locator('.evidence__confidence').first()).toHaveText('high');
  await expect(page.getByText('Subtitle').first()).toBeVisible();
});

test('exports a Fountain file carrying the reconstruction notice', async () => {
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export/ }).click();
  const file = await download;

  expect(file.suggestedFilename()).toBe('demo-en.en.fountain');
  const stream = await file.createReadStream();
  const content = await new Promise<string>((resolve) => {
    let text = '';
    stream.on('data', (chunk) => (text += String(chunk)));
    stream.on('end', () => resolve(text));
  });

  expect(content).toContain("We're out of milk.");
  expect(content).toContain('NOT an original, shooting, or production screenplay');
});

test('rejects a file that is not a screenplay', async () => {
  await drop([{ name: 'junk.srt', buffer: Buffer.from('this is not a subtitle file at all') }]);
  await expect(page.getByText(/No subtitle cues found/i)).toBeVisible();
});

test('lays out on a phone viewport without horizontal scrolling', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await drop([{ name: 'demo.en.srt', buffer: Buffer.from(EN_SRT) }]);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

/**
 * Analysis of a real media file, through the browser.
 *
 * The Node test in `tests/mediaAnalysis.test.ts` runs the engine over the same
 * fixture directly. This one goes through the app: File API intake,
 * `decodeAudioData`, the offline audio pass, and the resulting screenplay —
 * the path a user actually takes, and the only way to exercise the browser
 * codec layer.
 */
test('analyzes a real audio file end to end', async () => {
  const wav = readFileSync(fileURLToPath(new URL('../tests/fixtures/fixture-speech.wav', import.meta.url)));

  await page.setInputFiles('#framescript-file-input', [
    { name: 'fixture-speech.wav', mimeType: 'audio/wav', buffer: wav },
  ]);

  // The file is recognised as media and offered for analysis, not parsed as text.
  // The name appears both in the sources list and on the analyzer card, so the
  // locator is scoped to the card rather than made ambiguous.
  const analyzer = page.locator('.card', { hasText: 'Analyze media' });
  await expect(analyzer).toBeVisible();
  await expect(analyzer.getByText('fixture-speech.wav')).toBeVisible();

  await page.getByRole('button', { name: 'Analyze', exact: true }).click();

  // Decoding 14 s and running the full offline pass takes a moment.
  await expect(page.getByText(/Analyzed:/)).toBeVisible({ timeout: 45_000 });

  const summary = await page.getByText(/Analyzed:/).textContent();
  // The fixture holds exactly two utterances from two voices.
  expect(summary).toMatch(/2 speech regions/);
  expect(summary).toMatch(/2 speakers/);

  // Those became evidence, and evidence became a screenplay.
  const stats = page.locator('.stats');
  await expect(stats.locator('.stats__item', { hasText: 'Sound' }).locator('dd')).not.toHaveText('0');
});

test('reports honestly that local analysis does not transcribe or describe', async () => {
  const wav = readFileSync(fileURLToPath(new URL('../tests/fixtures/fixture-speech.wav', import.meta.url)));
  await page.setInputFiles('#framescript-file-input', [
    { name: 'fixture-speech.wav', mimeType: 'audio/wav', buffer: wav },
  ]);

  // The limit is stated before the user runs anything and wonders where the
  // dialogue went.
  await expect(page.getByText(/does not transcribe speech or describe what is visible/i)).toBeVisible();
});
