import { defineConfig } from 'oxfmt';

export default defineConfig({
  printWidth: 80,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  ignorePatterns: [
    '**/node_modules/**',
    '**/.turbo/**',
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/.agents/**',
    '**/.cursor/**',
    '**/.claude/**',
    // Hand-written docs stay outside Oxfmt until MDX round-trip is proven.
    '**/*.mdx',
    'AGENTS.md',
    'CLAUDE.md',
    'PRODUCT.md',
    'README.md',
    'CODE_OF_CONDUCT.md',
  ],
  sortImports: {
    groups: [
      'type-import',
      ['value-builtin', 'value-external'],
      'type-internal',
      'value-internal',
      ['type-parent', 'type-sibling', 'type-index'],
      ['value-parent', 'value-sibling', 'value-index'],
      'unknown',
    ],
  },
  sortPackageJson: {
    sortScripts: true,
  },
});
