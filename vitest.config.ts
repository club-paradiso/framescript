import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

/**
 * Two projects rather than one, because the suite genuinely needs two
 * environments: nearly everything is pure logic that should run in Node, while
 * `tests/dom/` drives a synthetic player fixture and needs a DOM.
 *
 * This used to be `environmentMatchGlobs`, which Vitest removed in v3. Projects
 * are the supported replacement and are stricter in a useful way — a test file
 * belongs to exactly one project, so a DOM test can no longer pick up the Node
 * environment by accident.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['tests/dom/**'],
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/dom/**/*.test.ts', 'tests/dom/**/*.test.tsx'],
          setupFiles: ['tests/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/ui/**', 'src/popup/**', 'src/sidepanel/**', 'src/options/**'],
    },
  },
});
