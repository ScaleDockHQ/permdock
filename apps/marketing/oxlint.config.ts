import { defineConfig } from 'oxlint';

import {
  core,
  ignorePatterns,
  oneLibraryPerConcern,
  react,
  test,
} from '@permdock/ox-config/oxlint';

export default defineConfig({
  extends: [core, react, test],
  ignorePatterns: [
    ...ignorePatterns,
    'components/ui/**',
    'components/reui/**',
    'components/blocks/**',
  ],
  rules: {
    ...oneLibraryPerConcern,
    // Long-form pages keep their copy in one file (1 finding).
    'eslint/max-lines': 'off',
    // Page components hold the page's JSX (12 findings).
    'eslint/max-lines-per-function': 'off',
    // Pages compose many section components (1 finding).
    'import/max-dependencies': 'off',
    // Changelog parsing compares optional regex groups with `undefined` (14 findings).
    'eslint/no-undefined': 'off',
    // Node built-ins are imported by name (3 findings).
    'unicorn/import-style': 'off',
    // Loaders resolve repo paths from `import.meta.url`, which Next.js bundling rewrites (3 findings).
    'unicorn/prefer-import-meta-properties': 'off',
    // Changelog and count loaders narrow regex groups and parsed JSON (4 findings).
    'typescript/no-unsafe-type-assertion': 'off',
    // Handlers and timers wrap void calls in arrow shorthand (8 findings).
    'typescript/no-confusing-void-expression': 'off',
    // JSX renders optional strings behind a truthiness check (5 findings).
    'typescript/strict-boolean-expressions': 'off',
    // The copy button takes an async click handler (1 finding).
    'typescript/no-misused-promises': 'off',
    // The copy button takes an async click handler (1 finding).
    'typescript/strict-void-return': 'off',
    // Effects return a cleanup only when they start a timer (1 finding).
    'typescript/consistent-return': 'off',
  },
  overrides: [
    {
      files: ['app/icon.tsx', 'lib/og.tsx'],
      rules: {
        // `ImageResponse` renders with Satori, which reads inline styles only (26 findings).
        'shadcn/no-inline-styles': 'off',
      },
    },
    {
      files: ['components/sections/adapter-logos.tsx'],
      rules: {
        // Third-party logos keep their official brand colours (10 findings).
        'shadcn/no-raw-colors': 'off',
      },
    },
    {
      files: ['next.config.ts'],
      rules: {
        // Next.js reads its own config before any env module can load (2 findings).
        'node/no-process-env': 'off',
      },
    },
  ],
});
