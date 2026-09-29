import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: ['src/**/*.browser.test.ts'],
          typecheck: {
            enabled: true,
            include: ['src/**/*.test-d.ts'],
            tsconfig: './tsconfig.typecheck.json',
            ignoreSourceErrors: true,
          },
        },
      },
      {
        // Svelte and Solid client builds: rune and signal reactivity only
        // exists under the `browser` condition.
        extends: true,
        plugins: [svelte()],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'browser',
          environment: 'happy-dom',
          // One `solid-js` instance: `solid-js/web` must not reach the Node
          // (server) build through an external import.
          server: { deps: { inline: [/solid-js/u] } },
          include: ['src/**/*.browser.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test-d.ts',
        'src/**/index.ts',
        'src/fixtures/**',
        // Build-time plugin: exercised by the CLI collect tests, not here.
        'src/next/plugin.ts',
        // Dynamic import of the optional `jose` peer.
        'src/jwt/load-jose.ts',
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 86,
        branches: 71,
        'src/core/**': {
          statements: 88,
          lines: 88,
          functions: 93,
          branches: 80,
        },
        'src/conditions/**': {
          statements: 95,
          lines: 95,
          functions: 100,
          branches: 93,
        },
        'src/testing/**': {
          statements: 94,
          lines: 94,
          functions: 95,
          branches: 78,
        },
      },
    },
  },
});
