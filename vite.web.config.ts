import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * FrameScript Studio — the web/mobile app.
 *
 * Builds from `web/` but resolves `@/core` into the shared engine in `src/`,
 * so the web app and the extension run the same reconstruction code rather
 * than two drifting copies.
 */
export default defineConfig({
  root: resolve(root, 'web'),
  base: '/',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  build: {
    outDir: resolve(root, 'dist-web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
