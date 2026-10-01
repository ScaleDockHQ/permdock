import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { CliIo, PermDockConfig } from '../../src/cli/types.ts';

import { pushedPolicy, runCloud } from '../../src/cli/cloud.ts';
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from '../../src/index.ts';
import { policy as namedScopes } from '../fixtures/named-scopes.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-app');
const TMP = path.join(import.meta.dirname, '../../tmp');
const NOW = new Date('2026-10-01T00:00:00.000Z');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tempDir(): string {
  mkdirSync(TMP, { recursive: true });
  const created = mkdtempSync(path.join(TMP, 'cloud-push-'));
  temps.push(created);
  return created;
}

const tree = definePermissions({
  doc: resource({ actions: ['read', 'share', 'purge'], collection: ['list'] }),
});

describe('pushedPolicy', () => {
  it('keeps portable conditions and marks closures non-portable', () => {
    const policy = definePolicy(tree, {
      roles: [
        role('member', [
          allow(tree.doc.read, { where: { ownerId: principal.id } }),
          allow(tree.doc.share, () => true),
          allow(tree.doc.list, { limit: { count: 10, per: 'hour' } }),
          deny(tree.doc.purge),
        ]),
        role('editor', [allow(tree.doc.share)], { on: tree.doc }),
      ],
      subject: () => null,
    });
    const pushed = pushedPolicy(policy);
    expect(pushed.fingerprint).toBe(policy.fingerprint);
    expect(pushed).not.toHaveProperty('scopes');
    const member = { kind: 'role', role: 'member', scope: 'global' };
    expect(JSON.parse(JSON.stringify(pushed.grants))).toEqual([
      {
        permission: 'doc.read',
        effect: 'allow',
        role: 'member',
        to: member,
        where: { op: 'eq', field: 'ownerId', value: { ref: 'principal.id' } },
      },
      {
        permission: 'doc.share',
        effect: 'allow',
        role: 'member',
        to: member,
        portable: false,
      },
      {
        permission: 'doc.list',
        effect: 'allow',
        role: 'member',
        to: member,
        portable: false,
        limit: { count: 10, per: 'hour' },
      },
      { permission: 'doc.purge', effect: 'deny', role: 'member', to: member },
      {
        permission: 'doc.share',
        effect: 'allow',
        role: 'editor',
        to: { kind: 'role', role: 'editor', scope: { resource: 'doc' } },
        scope: { resource: 'doc' },
      },
    ]);
  });

  it('carries the declared scopes and a named-scope grant scope', () => {
    const pushed = pushedPolicy(namedScopes);
    expect(pushed.scopes).toEqual([
      {
        name: 'organization',
        key: 'organization_id',
        resources: ['quote', 'invoice', 'asset'],
      },
      {
        name: 'customer',
        key: 'customer_id',
        within: 'organization',
        resources: ['quote', 'invoice', 'asset'],
      },
    ]);
    expect(
      pushed.grants.find(
        (grant) =>
          grant.role === 'contact' && grant.permission === 'quote.accept',
      ),
    ).toMatchObject({
      scope: 'customer',
      where: { op: 'eq', field: 'status', value: 'sent' },
    });
    expect(
      pushed.grants.find((grant) => grant.role === 'platform-admin'),
    ).not.toHaveProperty('scope');
  });
});

type Input = Parameters<typeof runCloud>[0];

const IO: CliIo = { stdout: () => undefined, stderr: () => undefined };
const CONFIG: PermDockConfig = {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  collect: { srcPath: ['./src'] },
};
const ENV = {
  PERMDOCK_CLOUD_URL: 'https://cloud.permdock.test',
  PERMDOCK_CLOUD_KEY: 'key',
};

function push(cwd: string, overrides: Partial<Input> = {}) {
  return runCloud({
    cwd,
    config: CONFIG,
    rest: ['push'],
    url: undefined,
    environment: undefined,
    dryRun: false,
    json: false,
    env: ENV,
    now: NOW,
    io: IO,
    ...overrides,
  });
}

describe('runCloud', () => {
  it('passes on a catalog that cannot be built', async () => {
    expect(await push(tempDir(), { config: {} })).toEqual({
      code: 2,
      output:
        'usage: set permissions in permdock.config.ts or pass a definePermissions module',
    });
  });

  it('describes a dry run in text, preferring --url and --environment', async () => {
    const result = await push(FIXTURE, {
      dryRun: true,
      url: 'https://flag.permdock.test/',
      environment: 'staging',
      env: { ...ENV, PERMDOCK_CLOUD_ENV: 'ignored', VERCEL_ENV: 'ignored' },
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /^would push catalog \S+ \(7 permissions, 0 hostable\) to staging$/u,
    );
  });

  it.each([
    [{ PERMDOCK_CLOUD_ENV: 'qa', VERCEL_ENV: 'preview' }, 'qa'],
    [{ PERMDOCK_CLOUD_ENV: '', VERCEL_ENV: 'preview' }, 'preview'],
    [{}, 'production'],
  ] as const)('picks the environment from %j', async (env, expected) => {
    const result = await push(FIXTURE, { dryRun: true, json: true, env });
    // SAFETY: the --json summary printed by `cloud push --dry-run`.
    const summary = JSON.parse(result.output) as {
      readonly environment: string;
    };
    expect(summary.environment).toBe(expected);
  });

  it('summarises a catalog with no policy, roles or plans', async () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(
      path.join(cwd, 'src/permissions.ts'),
      `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  doc: resource({ actions: ['read'] }),
});
`,
    );
    const result = await push(cwd, {
      config: {
        permissions: './src/permissions.ts',
        collect: { srcPath: ['./src'] },
      },
      dryRun: true,
      json: true,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      permissions: 1,
      hostable: [],
      roles: 0,
      plans: 0,
      grants: 0,
      environment: 'production',
      status: 'would push',
    });
  });

  it.each([
    [{ PERMDOCK_CLOUD_KEY: 'key' }],
    [{ PERMDOCK_CLOUD_URL: 'https://cloud.permdock.test' }],
    [{ PERMDOCK_CLOUD_URL: '', PERMDOCK_CLOUD_KEY: 'key' }],
  ])('needs a URL and a key (%j)', async (env) => {
    expect(await push(FIXTURE, { env })).toEqual({
      code: 2,
      output:
        'permdock cloud push needs PERMDOCK_CLOUD_URL (or --url) and PERMDOCK_CLOUD_KEY in the environment',
    });
  });

  it('posts through the global fetch and omits the policy without one', async () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(
      path.join(cwd, 'src/permissions.ts'),
      `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  doc: resource({ actions: ['read'] }),
});
`,
    );
    const bodies: unknown[] = [];
    const fetchStub = vi.fn<typeof fetch>((_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    vi.stubGlobal('fetch', fetchStub);
    const result = await push(cwd, {
      config: {
        permissions: './src/permissions.ts',
        collect: { srcPath: ['./src'] },
      },
      environment: 'a b',
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /^pushed catalog \S+ \(1 permissions, 0 hostable\) to a b$/u,
    );
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      'https://cloud.permdock.test/v1/environments/a%20b/catalog',
    );
    expect(bodies).toEqual([
      { fingerprint: expect.any(String), catalog: expect.any(Object) },
    ]);
  });

  it.each([
    [new Error('ECONNREFUSED'), 'PermDock Cloud unreachable: ECONNREFUSED'],
    ['socket hang up', 'PermDock Cloud unreachable: socket hang up'],
  ])('reports an unreachable Cloud (%s)', async (thrown, output) => {
    const io: CliIo = {
      ...IO,
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a fetch may reject with a non-Error
      fetch: () => Promise.reject(thrown),
    };
    expect(await push(FIXTURE, { io })).toEqual({ code: 1, output });
  });

  it('reports a rejected catalog with its status', async () => {
    const io: CliIo = {
      ...IO,
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
    };
    expect(await push(FIXTURE, { io })).toEqual({
      code: 1,
      output: 'PermDock Cloud rejected the catalog: HTTP 401',
    });
  });

  it.each([[[]], [['pull']]])('prints usage for %j', async (rest) => {
    expect((await push(FIXTURE, { rest })).code).toBe(2);
  });
});
