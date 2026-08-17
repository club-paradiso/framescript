import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Build for everything that Chrome loads as an ES module or an HTML document:
 * the MV3 service worker, the offscreen media document, and the three React
 * surfaces (popup, side panel, options).
 *
 * Content scripts cannot be ES modules, so they are built separately by
 * `vite.content.config.ts`.
 */
export default defineConfig({
  root: src,
  resolve: {
    alias: { '@': src },
  },
  plugins: [react()],
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  build: {
    outDir: resolve(src, '../dist'),
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: process.env.NODE_ENV !== 'production',
    modulePreload: false,
    rollupOptions: {
      input: {
        serviceWorker: resolve(src, 'background/serviceWorker.ts'),
        offscreen: resolve(src, 'offscreen/offscreen.html'),
        popup: resolve(src, 'popup/index.html'),
        sidepanel: resolve(src, 'sidepanel/index.html'),
        options: resolve(src, 'options/index.html'),
      },
      output: {
        format: 'es',
        entryFileNames: (chunk) =>
          chunk.name === 'serviceWorker' ? 'background/serviceWorker.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
