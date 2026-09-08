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
        'oxc/no-async-await': 'off',
        // Same-package folders (core/conditions) import each other.
        'import/no-relative-parent-imports': 'off',
        // exactOptionalPropertyTypes + compact() use `undefined` as a sentinel.
        'eslint/no-undefined': 'off',
        'unicorn/no-useless-undefined': 'off',
        'oxc/no-optional-chaining': 'off',
        'oxc/no-rest-spread-properties': 'off',
        'eslint/no-use-before-define': 'off',
        'typescript/prefer-readonly-parameter-types': 'off',
        'unicorn/no-array-callback-reference': 'off',
        'eslint/max-lines-per-function': 'off',
        // Generic trees, frozen JSON, and isolatedDeclarations need assertions.
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/no-unnecessary-type-assertion': 'off',
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unnecessary-type-parameters': 'off',
        'typescript/no-unnecessary-boolean-literal-compare': 'off',
        'typescript/no-base-to-string': 'off',
        'typescript/promise-function-async': 'off',
        'typescript/no-non-null-assertion': 'off',
        'typescript/no-unsafe-return': 'off',
        'eslint/max-lines': 'off',
        'eslint/complexity': 'off',
        'import/max-dependencies': 'off',
        'eslint/no-void': 'off',
        'eslint/no-bitwise': 'off',
        'unicorn/prefer-math-trunc': 'off',
        'eslint/max-classes-per-file': 'off',
      },
    },
    {
      files: [
        '**/*.config.ts',
        '**/*.config.mts',
        '**/vitest.config.ts',
        '**/tsdown.config.ts',
      ],
      rules: {
        'import/no-default-export': 'off',
      },
    },
    {
      files: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.test-d.ts',
        '**/fixtures/**/*.ts',
        'packages/testing/src/**/*.ts',
      ],
      rules: {
        'typescript/explicit-function-return-type': 'off',
        'typescript/explicit-module-boundary-types': 'off',
        'typescript/prefer-readonly-parameter-types': 'off',
        'vitest/require-test-timeout': 'off',
        'vitest/no-conditional-in-test': 'off',
        'vitest/no-conditional-expect': 'off',
        'eslint/max-lines-per-function': 'off',
        'eslint/require-unicode-regexp': 'off',
        'eslint/no-unused-vars': 'off',
        'import/no-relative-parent-imports': 'off',
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unnecessary-type-assertion': 'off',
        'typescript/require-await': 'off',
        'typescript/promise-function-async': 'off',
        'typescript/no-floating-promises': 'off',
        'typescript/no-confusing-void-expression': 'off',
        'eslint/max-lines': 'off',
        'import/max-dependencies': 'off',
        'eslint/require-await': 'off',
        'unicorn/prefer-type-error': 'off',
        'eslint/no-void': 'off',
        'typescript/no-non-null-assertion': 'off',
        'vitest/no-conditional-tests': 'off',
        'vitest/valid-title': 'off',
        'vitest/expect-expect': 'off',
        'eslint/no-await-in-loop': 'off',
        'typescript/no-unnecessary-template-expression': 'off',
      },
    },
    {
      files: ['tests/**/*.{ts,tsx}'],
      rules: {
        'oxc/no-async-await': 'off',
        'eslint/no-undefined': 'off',
        'unicorn/import-style': 'off',
        'unicorn/prefer-import-meta-properties': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/explicit-function-return-type': 'off',
        'typescript/explicit-module-boundary-types': 'off',
        'import/no-relative-parent-imports': 'off',
      },
    },
    {
      files: ['apps/examples/**/*.{ts,tsx}'],
      rules: {
        // App-router and factory files import across src/ folders.
        'import/no-relative-parent-imports': 'off',
        // Vite / Next client entries boot with top-level await.
        'node/no-top-level-await': 'off',
        // Adapter factories take Policy (TUser = unknown); typed policies need a cast.
        'typescript/no-unsafe-type-assertion': 'off',
        'typescript/no-unsafe-return': 'off',
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
