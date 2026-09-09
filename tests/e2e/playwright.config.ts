import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const inCi = Boolean(process.env.CI);

const httpExamples = [
  { name: 'hono', port: 3456 },
  { name: 'express', port: 3457 },
  { name: 'fastify', port: 3458 },
  { name: 'elysia', port: 3459 },
  { name: 'nest', port: 3460 },
  { name: 'trpc', port: 3461 },
  { name: 'orpc', port: 3462 },
  { name: 'better-auth', port: 3463 },
  { name: 'clerk', port: 3464 },
  { name: 'convex', port: 3465 },
  { name: 'drizzle', port: 3466 },
  { name: 'prisma', port: 3468 },
  { name: 'supabase-rls', port: 3469 },
  { name: 'authzen-pdp', port: 3470 },
  { name: 'a2a-agent', port: 3471 },
  { name: 'ai-sdk-agent', port: 3472 },
  { name: 'claude-agent', port: 3473 },
  { name: 'eve-agent', port: 3474 },
  { name: 'openai-agent', port: 3475 },
  { name: 'scim', port: 3476 },
] as const;

function envWith(extra: { readonly [key: string]: string }): {
  [key: string]: string;
} {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function httpServer(
  name: string,
  port: number,
): {
  readonly command: string;
  readonly cwd: string;
  readonly url: string;
  readonly reuseExistingServer: boolean;
  readonly timeout: number;
  readonly env: { [key: string]: string };
} {
  return {
    command: `pnpm --filter @permdock/example-${name} start`,
    cwd: root,
    url: `http://127.0.0.1:${String(port)}/health`,
    reuseExistingServer: !inCi,
    timeout: 30_000,
    env: envWith({ PORT: String(port) }),
  };
}

function uiServer(
  filter: string,
  port: number,
): {
  readonly command: string;
  readonly cwd: string;
  readonly url: string;
  readonly reuseExistingServer: boolean;
  readonly timeout: number;
  readonly env: { [key: string]: string };
} {
  return {
    command: `pnpm --filter ${filter} dev`,
    cwd: root,
    url: `http://127.0.0.1:${String(port)}/`,
    reuseExistingServer: !inCi,
    timeout: 120_000,
    env: envWith({
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
    }),
  };
}

const uiProjectNames = new Set([
  'react-vite',
  'vue',
  'svelte',
  'solid',
  'webmcp',
  'next',
  'expo',
]);

function requestedProjects(): readonly string[] {
  const names: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--project') {
      const next = process.argv[index + 1];
      if (next !== undefined) {
        names.push(next);
      }
    } else if (arg.startsWith('--project=')) {
      names.push(arg.slice('--project='.length));
    }
  }
  return names;
}

const requested = requestedProjects();
const uiOnly =
  requested.length > 0 && requested.every((name) => uiProjectNames.has(name));

export default defineConfig({
  testDir: './src',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: inCi ? 2 : 0,
  reporter: inCi ? 'github' : 'list',
  webServer: [
    ...(uiOnly
      ? []
      : httpExamples.map((example) => httpServer(example.name, example.port))),
    uiServer('@permdock/example-react-vite', 3480),
    uiServer('@permdock/example-vue', 3481),
    uiServer('@permdock/example-svelte', 3482),
    uiServer('@permdock/example-solid', 3483),
    uiServer('@permdock/example-webmcp', 3484),
    uiServer('@permdock/example-next', 3485),
    uiServer('@permdock/example-expo', 3486),
  ],
  projects: [
    ...httpExamples.map((example) => ({
      name: example.name,
      testMatch: `${example.name}.spec.ts`,
      use: { baseURL: `http://127.0.0.1:${String(example.port)}` },
    })),
    {
      name: 'terminal',
      testMatch: /terminal\.spec\.ts$/u,
    },
    {
      name: 'mcp-server',
      testMatch: /mcp-server\.spec\.ts$/u,
    },
    {
      name: 'react-vite',
      testMatch: /react-vite\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3480' },
    },
    {
      name: 'vue',
      testMatch: /vue\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3481' },
    },
    {
      name: 'svelte',
      testMatch: /svelte\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3482' },
    },
    {
      name: 'solid',
      testMatch: /solid\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3483' },
    },
    {
      name: 'webmcp',
      testMatch: /webmcp\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3484' },
    },
    {
      name: 'next',
      testMatch: /next\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3485' },
    },
    {
      name: 'expo',
      testMatch: /expo\.spec\.ts$/u,
      use: { baseURL: 'http://127.0.0.1:3486' },
    },
  ],
});
