import { defineConfig } from 'oxlint';

import {
  core,
  ignorePatterns,
  node,
  playwright,
  test,
} from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, node, test, playwright],
  ignorePatterns: [...ignorePatterns, 'fixtures/**', 'test-results/**'],
  overrides: [
    {
      files: [
        'src/next.spec.ts',
        'src/next-saas.spec.ts',
        'src/next-better-supabase.spec.ts',
      ],
      rules: {
        // `instant()` only passes once the prefetches have landed, which no locator shows (11 findings).
        'playwright/no-networkidle': 'off',
      },
    },
  ],
});
