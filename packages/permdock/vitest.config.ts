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
        'src/jwt/**',
        'src/react/**',
        'src/next/**',
        'src/server/**',
        'src/hono/**',
        'src/ai-sdk/**',
        'src/claude-agent/**',
        'src/eve/**',
        'src/agent/**',
        'src/core/from-snapshot.ts',
      ],
      thresholds: {
        statements: 95,
        lines: 95,
        functions: 95,
        branches: 93,
      },
    },
  },
});
