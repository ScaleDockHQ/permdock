import { defineConfig, devices } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const inCi = Boolean(process.env['CI']);

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
  { name: 'supabase-middleware', port: 3477 },
  { name: 'mcp-server', port: 3478 },
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
    command: 'node --run start',
    cwd: join(root, 'apps/examples', name),
    url: `http://127.0.0.1:${String(port)}/health`,
    reuseExistingServer: !inCi,
    timeout: 30_000,
    env: envWith({ PORT: String(port) }),
  };
}

function uiServer(
  dir: string,
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
    command: 'node --run dev',
    cwd: join(root, dir),
    url: `http://127.0.0.1:${String(port)}/`,
    reuseExistingServer: !inCi,
    timeout: 120_000,
    env: envWith({
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
    }),
  };
}

type Server = ReturnType<typeof httpServer>;

type Project = {
  readonly name: string;
  readonly port?: number;
  readonly servers: readonly Server[];
  /** Also run the spec at 390 px as `<name>-mobile`. */
  readonly mobile?: true;
};

const mobileSuffix = '-mobile';

/** A fixture that builds once and serves its production output (`scripts/serve.ts`). */
function fixtureServer(name: string, healthPort: number): Server {
  return {
    command: 'node --run serve',
    cwd: join(root, 'tests/e2e/fixtures', name),
    url: `http://127.0.0.1:${String(healthPort)}/api/health`,
    reuseExistingServer: !inCi,
    timeout: 600_000,
    env: envWith({ CI: '1' }),
  };
}

const docsServer: Server = {
  ...uiServer('apps/docs', 3488),
  url: 'http://127.0.0.1:3488/docs',
  env: envWith({ CI: '1', PORT: '3488' }),
};

const marketingServer: Server = {
  ...uiServer('apps/marketing', 3487),
  env: envWith({
    CI: '1',
    PORT: '3487',
    DOCS_ORIGIN: 'http://127.0.0.1:3488',
  }),
};

// `instant()` measures prefetches, which only `next start` performs.
const nextExampleServer: Server = {
  command: 'node --run build && node --run start',
  cwd: join(root, 'apps/examples/next'),
  url: 'http://127.0.0.1:3485/api/health',
  reuseExistingServer: !inCi,
  timeout: 600_000,
  env: envWith({ CI: '1', NEXT_E2E: '1', NEXT_TELEMETRY_DISABLED: '1' }),
};

// Owns its testcontainers Postgres: `next start` needs DATABASE_URL and the
// signing key before it boots, so a Playwright global setup is too late.
const nextBetterSupabaseServer: Server = {
  command: 'node --run serve',
  cwd: join(root, 'apps/examples/next-better-supabase'),
  url: 'http://127.0.0.1:3489/api/health',
  reuseExistingServer: !inCi,
  timeout: 600_000,
  env: envWith({ CI: '1', PORT: '3489' }),
};

// Builds once, then serves JWT mode on 3490, database mode on 3491 and the
// no-private-cache negative variant on 3492.
const saasServer: Server = {
  ...fixtureServer('next-saas', 3492),
};

/** The one project-to-servers map: a run starts only its projects' servers. */
const projectTable: readonly Project[] = [
  ...httpExamples.map((example) => ({
    name: example.name,
    port: example.port,
    servers: [httpServer(example.name, example.port)],
  })),
  { name: 'terminal', servers: [] },
  {
    name: 'react-vite',
    port: 3480,
    servers: [uiServer('apps/examples/react-vite', 3480)],
  },
  {
    name: 'vue',
    port: 3481,
    servers: [uiServer('apps/examples/vue', 3481)],
  },
  {
    name: 'svelte',
    port: 3482,
    servers: [uiServer('apps/examples/svelte', 3482)],
  },
  {
    name: 'solid',
    port: 3483,
    servers: [uiServer('apps/examples/solid', 3483)],
  },
  {
    name: 'webmcp',
    port: 3484,
    servers: [uiServer('apps/examples/webmcp', 3484)],
  },
  {
    name: 'next',
    port: 3485,
    servers: [nextExampleServer],
  },
  {
    name: 'expo',
    port: 3486,
    servers: [uiServer('apps/examples/expo', 3486)],
  },
  {
    name: 'marketing',
    port: 3487,
    servers: [docsServer, marketingServer],
    mobile: true,
  },
  { name: 'docs', port: 3488, servers: [docsServer], mobile: true },
  {
    name: 'next-better-supabase',
    port: 3489,
    servers: [nextBetterSupabaseServer],
  },
  { name: 'next-saas', port: 3490, servers: [saasServer] },
  {
    name: 'sveltekit-saas',
    port: 3500,
    servers: [fixtureServer('sveltekit-saas', 3500)],
  },
  {
    name: 'nuxt-saas',
    port: 3501,
    servers: [fixtureServer('nuxt-saas', 3501)],
  },
  {
    name: 'tanstack-start-saas',
    port: 3502,
    servers: [fixtureServer('tanstack-start-saas', 3502)],
  },
  {
    name: 'solidstart-saas',
    port: 3503,
    servers: [fixtureServer('solidstart-saas', 3503)],
  },
  {
    name: 'expo-saas',
    port: 3504,
    servers: [fixtureServer('expo-saas', 3504)],
  },
  {
    name: 'mcp-oauth',
    port: 3505,
    servers: [fixtureServer('mcp-oauth', 3505)],
  },
  {
    name: 'ai-chat',
    port: 3506,
    servers: [fixtureServer('ai-chat', 3506)],
  },
  {
    name: 'realtime-collab',
    port: 3507,
    servers: [fixtureServer('realtime-collab', 3507)],
  },
  {
    name: 'turborepo',
    port: 3508,
    servers: [fixtureServer('turborepo', 3508)],
  },
  {
    name: 'b2b-scim',
    port: 3510,
    servers: [fixtureServer('b2b-scim', 3510)],
  },
  {
    name: 'cloud-contract',
    port: 3511,
    servers: [fixtureServer('cloud-contract', 3511)],
  },
];

function requestedProjects(): readonly string[] {
  const names: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === '--project') {
      const next = process.argv[index + 1];
      if (next !== undefined) {
        names.push(next);
      }
    } else if (arg?.startsWith('--project=') === true) {
      names.push(arg.slice('--project='.length));
    }
  }
  return names;
}

function projectConfigs(project: Project) {
  const testMatch = new RegExp(`(^|/)${project.name}\\.spec\\.ts$`, 'u');
  const baseURL =
    project.port === undefined
      ? undefined
      : `http://127.0.0.1:${String(project.port)}`;
  const desktop =
    baseURL === undefined
      ? { name: project.name, testMatch }
      : { name: project.name, testMatch, use: { baseURL } };
  if (project.mobile !== true) {
    return [desktop];
  }
  return [
    desktop,
    {
      name: `${project.name}${mobileSuffix}`,
      testMatch,
      use: {
        ...devices['Desktop Chrome'],
        ...(baseURL === undefined ? {} : { baseURL }),
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ];
}

const requested = new Set(requestedProjects());
const selected =
  requested.size === 0
    ? projectTable
    : projectTable.filter(
        (project) =>
          requested.has(project.name) ||
          (project.mobile === true &&
            requested.has(`${project.name}${mobileSuffix}`)),
      );
const servers = [
  ...new Map(
    selected
      .flatMap((project) => project.servers)
      .map((server) => [server.url, server]),
  ).values(),
];

export default defineConfig({
  testDir: './src',
  fullyParallel: true,
  forbidOnly: inCi,
  // No retries anywhere: a flaky test fails the run; the nightly CI job repeats each test.
  retries: 0,
  reporter: inCi ? [['github'], ['list']] : 'list',
  webServer: servers,
  projects: projectTable.flatMap((project) => projectConfigs(project)),
});
