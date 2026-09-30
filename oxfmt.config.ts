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
    'packages/ui/src/**',
    'apps/marketing/components/blocks/**',
    'apps/marketing/components/examples/**',
    'tests/integration/src/support/prisma/**',
    'apps/examples/prisma/src/generated/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/.svelte-kit/**',
    'tests/e2e/fixtures/*/build/**',
    '**/routeTree.gen.ts',
  ],
});
