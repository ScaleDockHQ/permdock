import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: [
    '**/{dist,.next,coverage,.turbo,node_modules}/**',
    '.agents/**',
    '.cursor/**',
    '.claude/**',
  ],
  options: {
    typeAware: true,
  },
  plugins: [
    'eslint',
    'unicorn',
    'typescript',
    'oxc',
    'import',
    'node',
    'vitest',
  ],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'error',
    restriction: 'error',
    pedantic: 'error',
    style: 'off',
    nursery: 'off',
  },
  rules: {
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'typescript/no-explicit-any': 'error',
    'unicorn/prefer-module': 'error',
    'import/no-default-export': 'off',
  },
  overrides: [
    {
      files: ['packages/**/*.{ts,tsx,mts,cts}'],
      rules: {
        'import/no-default-export': 'error',
      },
    },
    {
      files: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/tests/**/*.{ts,tsx}',
        'tests/**/*.{ts,tsx}',
      ],
      plugins: [
        'eslint',
        'unicorn',
        'typescript',
        'oxc',
        'import',
        'node',
        'vitest',
      ],
    },
  ],
});
