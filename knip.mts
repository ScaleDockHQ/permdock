import type { KnipConfig } from 'knip';

// Entries below are files something starts or loads by path: the `permdock`
// CLI through `permdock.config.ts`, `scripts/serve.ts`, Playwright, or a
// test's child process.
const config: KnipConfig = {
  treatConfigHintsAsErrors: true,
  // The Vercel CLI is installed globally, not per repository.
  ignoreBinaries: ['vercel'],
  tags: ['-internal'],
  ignoreExportsUsedInFile: { interface: true, type: true },
  workspaces: {
    '.': {
      entry: ['scripts/*.{ts,mjs}'],
      project: ['*.{ts,mts}', 'scripts/**/*.{ts,mjs}'],
    },
    'apps/docs': {},
    'apps/marketing': {
      // shadcn and ReUI registry code is vendored whole, used or not.
      entry: ['components/{blocks,examples}/**/*.{ts,tsx}'],
    },
    'apps/examples/*': {
      // Example sources are read as documentation; their exports show the shape.
      entry: ['src/**/*.{ts,tsx,vue,svelte}'],
    },
    'apps/examples/expo': {
      entry: ['src/**/*.{ts,tsx}'],
      // Expo resolves these native peers and config plugins at build time.
      ignoreDependencies: [
        '@react-native/metro-config',
        'expo-modules-core',
        'expo-updates',
        'react-native-worklets',
      ],
    },
    'apps/examples/monorepo': {
      entry: ['permdock.config.ts', 'src/**/*.ts', 'packages/*/src/**/*.ts'],
    },
    'apps/examples/supabase-rls': {
      entry: ['permdock.config.ts', 'src/**/*.ts'],
    },
    'apps/examples/next-better-supabase': {
      entry: [
        'permdock.config.ts',
        'better-supabase.config.ts',
        'scripts/*.ts',
        'src/**/*.{ts,tsx}',
      ],
    },
    'packages/*': {},
    'packages/ui': {
      // shadcn and ReUI registry code is vendored whole, used or not.
      entry: ['src/**/*.{ts,tsx}'],
    },
    'packages/permdock': {
      // `fromResponse` is the documented alias of `sendResponse` in `permdock/node`.
      ignoreIssues: { 'src/node/http.ts': ['duplicates'] },
      entry: [
        'tests/cli/fixtures/*/permdock.config.ts',
        'tests/cli/fixtures/*/src/*.ts',
        // Loaded by path as the CLI's `policy` module.
        'tests/fixtures/rls-standard.ts',
      ],
    },
    'tests/*': {},
    'tests/e2e': {
      // Listed so turbo builds every app Playwright starts.
      ignoreDependencies: [
        /^@permdock\/(?:e2e|example)-/u,
        'docs',
        'marketing',
      ],
    },
    'tests/bundle': {
      entry: ['src/fixtures/rsc/{register,render}.ts'],
    },
    'tests/integration': {
      entry: ['fixtures/**/*.ts', 'src/support/openai-resume.ts'],
      // The gitignored client `prisma generate` writes to src/support/prisma imports its runtime.
      ignoreDependencies: ['@prisma/client'],
    },
    'tests/runtimes': {
      entry: ['src/serve-{bun,deno}.ts', 'src/worker.ts'],
      // The suite spawns the `deno` binary this package installs.
      ignoreDependencies: ['deno'],
    },
    'tests/types': {
      entry: ['src/smoke.ts'],
    },
    'tests/types/*': {
      // Listed so turbo builds them before this TypeScript version checks `../src`.
      ignoreDependencies: ['permdock', 'zod'],
    },
    'tests/e2e/fixtures/*': {},
    'tests/e2e/fixtures/ai-chat': {
      entry: ['src/server/index.ts'],
    },
    'tests/e2e/fixtures/b2b-scim': {
      entry: ['src/server.ts'],
    },
    'tests/e2e/fixtures/cloud-contract': {
      entry: ['permdock.config.ts', 'src/server.ts'],
    },
    'tests/e2e/fixtures/expo-saas': {
      entry: ['scripts/start.ts'],
      // Expo resolves these native peers and config plugins at build time.
      ignoreDependencies: [
        '@react-native/metro-config',
        'expo-modules-core',
        'expo-updates',
        'react-native-worklets',
      ],
    },
    'tests/e2e/fixtures/mcp-oauth': {
      entry: ['src/server.ts'],
    },
    'tests/e2e/fixtures/realtime-collab': {
      entry: ['src/server.ts'],
    },
    'tests/e2e/fixtures/solidstart-saas': {
      // The SolidStart Vite plugin only loads with the fixture as the working directory.
      vite: false,
      entry: [
        'src/{app,entry-client,entry-server}.tsx',
        'src/middleware.ts',
        'src/routes/**/*.tsx',
      ],
    },
    'tests/e2e/fixtures/tanstack-start-saas': {
      entry: ['scripts/start.ts', 'src/routes/**/*.tsx'],
    },
    'tests/e2e/fixtures/turborepo': {
      entry: ['permdock.config.ts', 'scripts/build.ts'],
      // Listed so the fixture's own turbo run builds its apps.
      ignoreDependencies: [/^@permdock\/e2e-turbo-/u],
    },
    'tests/e2e/fixtures/turborepo/apps/*': {},
    'tests/e2e/fixtures/turborepo/apps/api': {
      entry: ['src/server.ts'],
    },
    'tests/e2e/fixtures/turborepo/apps/web': {
      entry: ['permdock.config.ts'],
    },
    'tests/e2e/fixtures/turborepo/apps/worker': {
      entry: ['src/worker.ts'],
    },
    'tests/e2e/fixtures/turborepo/packages/*': {},
  },
};

export default config;
