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
  ],
});
