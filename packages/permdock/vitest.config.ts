import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
      ignoreSourceErrors: true,
    },
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
      },
    },
  },
});
