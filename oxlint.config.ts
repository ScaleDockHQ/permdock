import { base, ignorePatterns } from '@permdock/ox-config/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [base],
  ignorePatterns: [...ignorePatterns, '.agents/**', '.cursor/**', '.claude/**'],
  options: {
    typeAware: true,
  },
  overrides: [
    {
      files: ['packages/**/*.{ts,tsx,mts,cts}'],
      rules: {
        'import/no-default-export': 'error',
      },
    },
    {
      files: ['apps/**/*.{ts,tsx,mts,cts}'],
      rules: {
        // Next.js Server Components, route handlers and `next.config` redirects.
        'oxc/no-async-await': 'off',
        // MDX component maps and Fumadocs layout props.
        'oxc/no-rest-spread-properties': 'off',
        'oxc/no-optional-chaining': 'off',
        // Framework file conventions: pages, layouts, CSS entry, generated props.
        'typescript/explicit-function-return-type': 'off',
        'typescript/explicit-module-boundary-types': 'off',
        'typescript/prefer-readonly-parameter-types': 'off',
        'import/no-unassigned-import': 'off',
        'unicorn/no-array-callback-reference': 'off',
      },
    },
  ],
});
