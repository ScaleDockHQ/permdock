import { oxfmt } from '@permdock/ox-config/oxfmt';

export default oxfmt({
  ignorePatterns: [
    '**/.agents/**',
    '**/.cursor/**',
    '**/.claude/**',
    '**/permissions.catalog.json',
    'AGENTS.md',
    'CLAUDE.md',
    'PRODUCT.md',
    'README.md',
    'CODE_OF_CONDUCT.md',
  ],
});
