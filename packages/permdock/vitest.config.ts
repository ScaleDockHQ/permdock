import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

declare module 'vitest' {
  interface ProvidedContext {
    readonly requireAuthzenVectors: boolean;
  }
}

export default defineConfig({
  test: {
    // CI fetches the official AuthZEN vectors first; a missing file there fails.
    provide: { requireAuthzenVectors: process.env['CI'] !== undefined },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['tests/**/*.browser.test.ts'],
          typecheck: {
            enabled: true,
            include: ['tests/**/*.test-d.ts'],
            tsconfig: './tests/tsconfig.json',
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
          include: ['tests/**/*.browser.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',
        'src/cli/bin.ts',
        // Dynamic import of the optional `jose` peer.
        'src/jwt/load-jose.ts',
      ],
      thresholds: {
        statements: 98,
        lines: 98,
        functions: 99,
        branches: 95,
        'src/core/**': {
          statements: 97,
          lines: 97,
          functions: 98,
          branches: 95,
        },
        'src/conditions/**': {
          statements: 96,
          lines: 96,
          functions: 100,
          branches: 95,
        },
        'src/cli/**': {
          statements: 98,
          lines: 98,
          functions: 99,
          branches: 96,
        },
        'src/testing/**': {
          statements: 97,
          lines: 97,
          functions: 98,
          branches: 90,
        },
      },
    },
  },
});
