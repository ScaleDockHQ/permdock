import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliIo } from '../../src/cli/types.ts';

import { run } from '../../src/cli/run.ts';
import { catalogFingerprint } from '../../src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, './fixtures/mini-app');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'cloud-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(
    join(dir, 'src/hostable-policy.ts'),
    `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [allow(permissions.post.read)]),
    role('editor', [allow(permissions.post.publish, { approval: 'human' })]),
  ],
  subject: () => null,
  hostable: [permissions.post.publish],
});
`,
  );
  writeFileSync(
    join(dir, 'permdock.config.ts'),
    `export default {
  permissions: './src/permissions.ts',
  policy: './src/hostable-policy.ts',
  collect: { srcPath: ['./src'] },
  catalog: { out: './permissions.catalog.json' },
};
`,
  );
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function io(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): CliIo {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    env,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

describe('permdock cloud push', () => {
  it('posts the catalog with its fingerprint and the environment key', async () => {
    const cwd = appCopy();
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const result = await run(['cloud', 'push', '--json'], {
      cwd,
      io: io(
        {
          PERMDOCK_CLOUD_URL: 'https://cloud.permdock.test/',
          PERMDOCK_CLOUD_KEY: 'env-key',
          VERCEL_ENV: 'preview',
        },
        fetchImpl,
      ),
    });
    expect(result.code).toBe(0);
    // SAFETY: the --json summary printed by `cloud push` under test.
    const summary = JSON.parse(result.stdout) as {
      readonly hostable: readonly string[];
      readonly environment: string;
      readonly fingerprint: string;
    };
    expect(summary.hostable).toEqual(['post.publish']);
    expect(summary.environment).toBe('preview');
    const request = requests[0];
    expect(request?.url).toBe(
      'https://cloud.permdock.test/v1/environments/preview/catalog',
    );
    expect(request?.headers.get('authorization')).toBe('Bearer env-key');
    // SAFETY: the request body sent by `cloud push` under test, captured by fetchImpl.
    const body = (await request?.json()) as {
      readonly fingerprint: string;
      readonly catalog: {
        readonly fingerprint: string;
        readonly permissions: readonly {
          readonly key: string;
          readonly hostable?: true;
          readonly approvals?: readonly unknown[];
        }[];
        readonly roles: readonly { readonly key: string }[];
      };
      readonly policy?: { readonly grants: readonly unknown[] };
    };
    expect(body.fingerprint).toBe(summary.fingerprint);
    expect(body.catalog.fingerprint).toBe(body.fingerprint);
    expect(catalogFingerprint(body.catalog)).toBe(body.fingerprint);
    expect(
      body.catalog.permissions.find((item) => item.key === 'post.publish')
        ?.approvals,
    ).toEqual(['human']);
    expect(
      body.catalog.permissions.find((item) => item.key === 'post.read')
        ?.approvals,
    ).toBeUndefined();
    expect(
      body.catalog.permissions.find((item) => item.key === 'post.publish')
        ?.hostable,
    ).toBe(true);
    expect(body.catalog.roles).toContainEqual({
      key: 'member',
      assignable: false,
    });
    expect(body.policy).not.toHaveProperty('scopes');
    expect(body.policy?.grants).toEqual([
      {
        permission: 'post.read',
        effect: 'allow',
        role: 'member',
        to: { kind: 'role', role: 'member', scope: 'global' },
      },
      {
        permission: 'post.publish',
        effect: 'allow',
        role: 'editor',
        to: { kind: 'role', role: 'editor', scope: 'global' },
        approval: 'human',
      },
    ]);
  });

  it('keeps the same fingerprint across runs', async () => {
    const cwd = appCopy();
    const first = await run(['cloud', 'push', '--dry-run', '--json'], {
      cwd,
      io: io({}),
    });
    const second = await run(['cloud', 'push', '--dry-run', '--json'], {
      cwd,
      io: io({}),
    });
    expect(first.code).toBe(0);
    // SAFETY: both outputs are the --json summary printed by `cloud push --dry-run`.
    expect(
      (JSON.parse(first.stdout) as { readonly fingerprint: string })
        .fingerprint,
    ).toBe(
      (JSON.parse(second.stdout) as { readonly fingerprint: string })
        .fingerprint,
    );
  });

  it('refuses to push without a key and reports a rejected catalog', async () => {
    const cwd = appCopy();
    const missing = await run(['cloud', 'push'], {
      cwd,
      io: io({ PERMDOCK_CLOUD_URL: 'https://cloud.permdock.test' }),
    });
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain('PERMDOCK_CLOUD_KEY');
    const rejected = await run(['cloud', 'push'], {
      cwd,
      io: io(
        {
          PERMDOCK_CLOUD_URL: 'https://cloud.permdock.test',
          PERMDOCK_CLOUD_KEY: 'k',
        },
        () => Promise.resolve(new Response(null, { status: 409 })),
      ),
    });
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toContain('409');
  });

  it('prints usage for an unknown cloud action', async () => {
    const result = await run(['cloud', 'pull'], { io: io({}) });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('cloud push');
  });
});
