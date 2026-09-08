import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/bin.ts', 'src/fixtures/**'],
      thresholds: {
        statements: 70,
        lines: 70,
        functions: 70,
        branches: 55,
      },
    },
  },
});
