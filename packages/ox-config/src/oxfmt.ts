import { type OxfmtConfig, defineConfig } from 'oxfmt';

const ignorePatterns: readonly string[] = [
  '**/node_modules/**',
  '**/.turbo/**',
  '**/dist/**',
  '**/.next/**',
  '**/coverage/**',
  // Hand-written docs stay outside Oxfmt until MDX round-trip is proven.
  '**/*.mdx',
];

export interface OxfmtOptions {
  /** Extra gitignore-style patterns, rooted at the consuming config file. */
  readonly ignorePatterns?: readonly string[];
}

/**
 * Shared Oxfmt configuration for every workspace in the repository.
 *
 * Oxfmt has no `extends`, so this is a factory. Formatting options are fixed
 * on purpose: only the ignore list may differ between workspaces.
 *
 * ```ts
 * import { oxfmt } from '@permdock/ox-config/oxfmt';
 *
 * export default oxfmt({ ignorePatterns: ['generated/**'] });
 * ```
 */
export function oxfmt(options: OxfmtOptions = {}): OxfmtConfig {
  return defineConfig({
    printWidth: 80,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    ignorePatterns: [...ignorePatterns, ...(options.ignorePatterns ?? [])],
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
}
