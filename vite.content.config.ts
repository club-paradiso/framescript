import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Content scripts and the optional MAIN-world bridge must be single, classic
 * (non-module) files. Each is bundled as a self-contained IIFE.
 *
 * `FS_CONTENT_ENTRY` selects which one to build; `scripts/build.mjs` invokes
 * this config once per entry.
 */
const entries: Record<string, { input: string; outFile: string }> = {
  content: { input: resolve(src, 'content/entry.ts'), outFile: 'content/entry.js' },
  bridge: { input: resolve(src, 'content/mainWorldBridge.ts'), outFile: 'content/mainWorldBridge.js' },
  // The AudioWorklet runs in its own global scope and is loaded by URL, so it
  // must also be a standalone classic file rather than an ES module chunk.
  audioWorklet: { input: resolve(src, 'offscreen/audioWorklet.ts'), outFile: 'offscreen/audioWorklet.js' },
};

const key = process.env.FS_CONTENT_ENTRY ?? 'content';
const entry = entries[key];
if (!entry) throw new Error(`Unknown content entry: ${key}`);

export default defineConfig({
  root: src,
  resolve: { alias: { '@': src } },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  build: {
    outDir: resolve(src, '../dist'),
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: process.env.NODE_ENV !== 'production',
    cssCodeSplit: false,
    rollupOptions: {
      input: entry.input,
      output: {
        format: 'iife',
        entryFileNames: entry.outFile,
        assetFileNames: `content/${key}[extname]`,
        inlineDynamicImports: true,
      },
    },
  },
});
