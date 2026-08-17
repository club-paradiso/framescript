import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Node-targeted build for the CLI and the MCP server.
 *
 * Both import the shared engine from `src/core`, so they need bundling rather
 * than plain `tsc` output — the engine uses path aliases and ships as source.
 * Node built-ins and the MCP SDK stay external so the output is small and the
 * SDK resolves from node_modules at runtime.
 */
const entries: Record<string, string> = {
  cli: resolve(root, 'tools/cli/index.ts'),
  mcp: resolve(root, 'tools/mcp/server.ts'),
};

const key = process.env.FS_TOOL_ENTRY ?? 'cli';
const input = entries[key];
if (!input) throw new Error(`Unknown tool entry: ${key}`);

export default defineConfig({
  resolve: { alias: { '@': resolve(root, 'src') } },
  build: {
    outDir: resolve(root, 'dist-tools'),
    emptyOutDir: false,
    target: 'node20',
    ssr: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input,
      external: [/^node:/, /^@modelcontextprotocol\//, 'zod'],
      output: {
        format: 'es',
        entryFileNames: `${key}.js`,
        banner: key === 'cli' || key === 'mcp' ? '#!/usr/bin/env node' : undefined,
      },
    },
  },
});
