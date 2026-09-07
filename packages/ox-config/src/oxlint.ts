import { type OxlintConfig, defineConfig } from 'oxlint';

/**
 * Build output and caches that no workspace should lint.
 *
 * `extends` merges `rules`, `plugins` and `overrides`, but a consumer's own
 * `ignorePatterns` replaces the inherited list. Consumers that add ignores
 * must spread this constant in front of their own patterns.
 */
export const ignorePatterns: readonly string[] = [
  '**/{dist,.next,coverage,.turbo,node_modules}/**',
];

/**
 * Shared Oxlint baseline for every workspace in the repository.
 *
 * Consumers pass it through `extends`:
 *
 * ```ts
 * import { base, ignorePatterns } from '@permdock/ox-config/oxlint';
 * import { defineConfig } from 'oxlint';
 *
 * export default defineConfig({
 *   extends: [base],
 *   ignorePatterns: [...ignorePatterns, 'generated/**'],
 * });
 * ```
 *
 * The `options.typeAware` switch is deliberately absent: type-aware linting
 * runs once, from the root config, over the whole repository.
 */
export const base: OxlintConfig = defineConfig({
  ignorePatterns: [...ignorePatterns],
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
    // Invariant 10: no eval, no `new Function`.
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'typescript/no-explicit-any': 'error',
    'unicorn/prefer-module': 'error',
    // Config files (`*.config.ts`) need a default export; publishable
    // packages turn this back on via an override in the root config.
    'import/no-default-export': 'off',
  },
  overrides: [
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
