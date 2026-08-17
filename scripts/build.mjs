#!/usr/bin/env node
/**
 * FrameScript build orchestrator.
 *
 * Chrome MV3 needs three different output shapes from one source tree:
 *   1. ES modules + HTML   -> service worker, offscreen document, React surfaces
 *   2. classic IIFE files  -> content script, MAIN-world bridge
 *   3. static files        -> manifest.json, icons
 *
 * Vite cannot express all three in a single config, so this script runs the
 * builds in sequence and then copies the static payload.
 */
import { build } from 'vite';
import { mkdir, rm, cp, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const mode = process.env.NODE_ENV === 'production' || !watch ? 'production' : 'development';
process.env.NODE_ENV = mode;

/** @param {string} p */
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

async function clean() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
}

async function buildApp() {
  await build({
    configFile: resolve(root, 'vite.config.ts'),
    mode,
    build: watch ? { watch: {} } : {},
  });
}

async function buildContent() {
  for (const entry of ['content', 'bridge', 'audioWorklet']) {
    process.env.FS_CONTENT_ENTRY = entry;
    await build({
      configFile: resolve(root, 'vite.content.config.ts'),
      mode,
      build: watch ? { watch: {} } : {},
    });
  }
  delete process.env.FS_CONTENT_ENTRY;
}

async function copyStatic() {
  const manifestSrc = resolve(root, 'src/manifest.json');
  const manifest = JSON.parse(await readFile(manifestSrc, 'utf8'));

  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  manifest.version = pkg.version;

  await mkdir(dist, { recursive: true });
  await writeFile(resolve(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const icons = resolve(root, 'src/assets/icons');
  if (await exists(icons)) {
    await mkdir(resolve(dist, 'icons'), { recursive: true });
    await cp(icons, resolve(dist, 'icons'), { recursive: true });
  }

  // Vite emits HTML at <outDir>/<path-relative-to-root>; nothing to relocate,
  // but make sure the directories the manifest references actually exist.
  const htmlFiles = [
    'popup/index.html',
    'sidepanel/index.html',
    'options/index.html',
    'offscreen/offscreen.html',
  ];
  for (const p of htmlFiles) {
    const full = resolve(dist, p);
    if (!(await exists(full))) throw new Error(`Expected build output missing: dist/${p}`);

    // Vite stamps `crossorigin` on emitted script/link tags. On chrome-extension://
    // pages that turns a same-origin fetch into a CORS request, which Chrome can
    // refuse; the absolute /assets/... paths already resolve to the extension root,
    // so the attribute buys nothing and is stripped.
    const html = await readFile(full, 'utf8');
    await writeFile(full, html.replace(/\s+crossorigin(?==|\s|>)/g, ''), 'utf8');
  }
  await mkdir(dirname(resolve(dist, 'content/entry.js')), { recursive: true });
}

async function main() {
  if (!watch) await clean();
  await buildApp();
  await buildContent();
  await copyStatic();
  process.stdout.write(`\nFrameScript build complete -> ${dist}\n`);
  if (watch) process.stdout.write('Watching for changes...\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
