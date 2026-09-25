import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/mini-app');
const TMP = join(HERE, '../tmp');

const temps: string[] = [];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'rls-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('permdock rls', () => {
  it('prints command help when no subcommand is given', async () => {
    const result = await run(['rls']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('generate');
    expect(result.stdout).toContain('import');
    expect(result.stdout).toContain('verify');
  });

  it('lists rls in --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rls');
  });

  it('generates SQL without service_role and compiles principal.id', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'supabase',
        '--out',
        'rls.sql',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
    expect(sql).not.toMatch(/service_role/i);
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all');
    expect(sql).toContain('(select auth.uid())');
    expect(sql).toContain('for update');
    expect(sql).toContain('with check');
    expect(sql).toContain('for select');
    expect(result.stdout).toMatch(/approval:human|skipped approval/i);
  });

  it('generate --check reports drift then up to date', async () => {
    const cwd = appCopy();
    const missing = await run(
      ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql', '--check'],
      { cwd },
    );
    expect(missing.code).toBe(1);
    await run(['rls', 'generate', '--target', 'sql', '--out', 'rls.sql'], {
      cwd,
    });
    const fresh = await run(
      ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql', '--check'],
      { cwd },
    );
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toContain('up to date');
  });

  it('compiles memberOf through a memberships table mapping', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/tenant-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

const admin = role('admin', [allow(permissions.post.read)], { on: 'tenant' });

export const policy = definePolicy(permissions, {
  roles: [admin],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
    );
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'supabase',
        '--memberships',
        'organization_members:organization_id,user_id,role',
        '--out',
        'rls.sql',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
    expect(sql).toContain('exists (select 1 from "organization_members"');
    expect(sql).toContain('m."organization_id" = "orgId"');
    expect(sql).not.toMatch(/service_role/i);
  });

  it('emits the custom access token hook and authorize() with --rbac-scaffold', async () => {
    const cwd = appCopy();
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'supabase',
        '--rbac-scaffold',
        '--out',
        'rls.sql',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'pg-functions://postgres/public/custom_access_token_hook',
    );
    const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
    expect(sql).toContain('custom_access_token_hook');
    expect(sql).toContain('create or replace function "public"."authorize"(');
    expect(sql).toContain('requested_tenant text default null');
    expect(sql).toContain(
      'grant usage on schema "public" to supabase_auth_admin;',
    );
    expect(sql).toContain('(select "public".authorize(\'post.read\'))');
    expect(sql).not.toMatch(/service_role/i);
  });

  it('rejects unknown --rbac values, bad --authorize and non-supabase dialects', async () => {
    const cwd = appCopy();
    const base = ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql'];
    expect((await run([...base, '--rbac', 'clerk'], { cwd })).code).toBe(2);
    expect(
      (
        await run([...base, '--rbac', 'supabase', '--authorize', 'cookie'], {
          cwd,
        })
      ).code,
    ).toBe(2);
    expect(
      (await run([...base, '--rbac', 'supabase', '--dialect', 'neon'], { cwd }))
        .code,
    ).toBe(2);
  });

  for (const mode of ['database', 'jwt'] as const) {
    it(`matches the ${mode}-mode RBAC golden file (2 roles, 7 permissions)`, async () => {
      const cwd = appCopy();
      writeFileSync(
        join(cwd, 'src/rbac-policy.ts'),
        `import { allow, definePolicy, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

const { post } = permissions;

const admin = role('admin', [
  allow(post.read),
  allow(post.update),
  allow(post.delete),
  allow(post.publish),
  allow(post.archive),
  allow(post.create),
  allow(post.list),
]);

const member = role(
  'member',
  [
    allow(post.read),
    allow(post.list),
    allow(post.create),
    allow(post.update, { where: { authorId: principal.id } }),
  ],
  { on: 'tenant' },
);

export const policy = definePolicy(permissions, {
  roles: [admin, member],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
      );
      writeFileSync(
        join(cwd, 'permdock.config.ts'),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/rbac-policy.ts',
};
`,
      );
      const result = await run(
        [
          'rls',
          'generate',
          '--target',
          'sql',
          '--dialect',
          'supabase',
          '--rbac',
          'supabase',
          '--authorize',
          mode,
          ...(mode === 'jwt' ? ['--rbac-schema', 'app'] : []),
          '--memberships',
          'organization_members:organization_id,user_id,role',
          '--out',
          'rls.sql',
        ],
        { cwd },
      );
      expect(result.code).toBe(0);
      const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
      expect(sql).not.toMatch(/service_role/i);
      await expect(sql).toMatchFileSnapshot(
        `../fixtures/golden/rbac-supabase-${mode}.sql`,
      );
    });
  }

  it('import writes permissions.generated.ts from a SQL dump', async () => {
    const cwd = appCopy();
    await run(['rls', 'generate', '--target', 'sql', '--out', 'schema.sql'], {
      cwd,
    });
    const imported = await run(
      [
        'rls',
        'import',
        '--sql',
        'schema.sql',
        '--out',
        'src/permissions.generated.ts',
        '--memberships',
        'organization_members:organization_id,user_id,role',
      ],
      { cwd },
    );
    expect(imported.code).toBe(0);
    const generated = readFileSync(
      join(cwd, 'src/permissions.generated.ts'),
      'utf8',
    );
    expect(generated).toContain('// @generated');
    expect(generated).toContain('definePermissions');
    expect(generated).toContain('export const catalog');
    expect(generated).toContain('principal.id');
  });

  it('verify fixtures carry memberships and tenant and match can()', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'rls.fixtures.json'),
      `${JSON.stringify(
        [
          {
            subject: {
              id: 'user-1',
              roles: ['member'],
              tenant: 'org-1',
              memberships: [{ tenant: 'org-1', roles: ['member'] }],
            },
            row: {
              id: 'p1',
              authorId: 'user-1',
              orgId: 'org-1',
              published: true,
            },
            action: 'post.update',
            expected: 'granted',
          },
          {
            subject: {
              id: 'user-2',
              roles: ['member'],
              tenant: 'org-1',
              memberships: [{ tenant: 'org-1', roles: ['member'] }],
            },
            row: {
              id: 'p1',
              authorId: 'user-1',
              orgId: 'org-1',
              published: true,
            },
            action: 'post.update',
            expected: 'denied',
          },
        ],
        null,
        2,
      )}\n`,
    );
    const result = await run(
      ['rls', 'verify', '--fixtures', 'rls.fixtures.json'],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('verified');
  });

  it('compiles neon and guc subject dialects', async () => {
    const cwd = appCopy();
    const neon = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'neon',
        '--out',
        'neon.sql',
      ],
      { cwd },
    );
    expect(neon.code).toBe(0);
    expect(readFileSync(join(cwd, 'neon.sql'), 'utf8')).toContain(
      '(select auth.user_id())',
    );
    const guc = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--dialect',
        'guc',
        '--guc-prefix',
        'app',
        '--out',
        'guc.sql',
      ],
      { cwd },
    );
    expect(guc.code).toBe(0);
    expect(readFileSync(join(cwd, 'guc.sql'), 'utf8')).toContain(
      "current_setting('app.user_id', true)",
    );
  });

  it('compiles tenant memberOf to the jwt claim when no table is mapped', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/tenant-policy.ts'),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

const admin = role('admin', [allow(permissions.post.read)], { on: 'tenant' });

export const policy = definePolicy(permissions, {
  roles: [admin],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
    );
    const result = await run(
      ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql'],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(readFileSync(join(cwd, 'rls.sql'), 'utf8')).toContain(
      `"orgId" = ((select auth.jwt()) ->> 'tenant_id')`,
    );
  });

  it('rejects an unknown generate target and import without --sql', async () => {
    const cwd = appCopy();
    const target = await run(['rls', 'generate', '--target', 'mysql'], { cwd });
    expect(target.code).toBe(2);
    const imported = await run(['rls', 'import'], { cwd });
    expect(imported.code).toBe(2);
    expect(imported.stdout).toContain('--sql');
  });

  it('verify --format pgtap emits memberships and tenant claims', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'rls.fixtures.json'),
      `${JSON.stringify([
        {
          subject: {
            id: 'user-1',
            roles: ['member'],
            tenant: 'org-1',
            memberships: [{ tenant: 'org-1', roles: ['member'] }],
          },
          row: {
            id: 'p1',
            authorId: 'user-1',
            orgId: 'org-1',
            published: true,
          },
          action: 'post.read',
        },
      ])}\n`,
    );
    const result = await run(
      ['rls', 'verify', '--fixtures', 'rls.fixtures.json', '--format', 'pgtap'],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('select plan(');
    expect(result.stdout).toContain('tenant_id');
    expect(result.stdout).toContain('memberships');
  });

  it('verify exits 1 when can() disagrees with expected', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'rls.fixtures.json'),
      `${JSON.stringify([
        {
          subject: {
            id: 'user-2',
            roles: ['member'],
            tenant: 'org-1',
            memberships: [{ tenant: 'org-1', roles: ['member'] }],
          },
          row: {
            id: 'p1',
            authorId: 'user-1',
            orgId: 'org-1',
            published: true,
          },
          action: 'post.update',
          expected: 'granted',
        },
      ])}\n`,
    );
    const result = await run(
      ['rls', 'verify', '--fixtures', 'rls.fixtures.json'],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('denied');
  });

  it('writes drizzle and prisma targets', async () => {
    const cwd = appCopy();
    const drizzle = await run(
      ['rls', 'generate', '--target', 'drizzle', '--out', 'src/db/policies.ts'],
      { cwd },
    );
    expect(drizzle.code).toBe(0);
    expect(readFileSync(join(cwd, 'src/db/policies.ts'), 'utf8')).toContain(
      'pgPolicy',
    );
    const prisma = await run(
      [
        'rls',
        'generate',
        '--target',
        'prisma',
        '--out',
        'prisma/policies.prisma',
      ],
      { cwd },
    );
    expect(prisma.code).toBe(0);
    expect(readFileSync(join(cwd, 'prisma/policies.prisma'), 'utf8')).toContain(
      '@@rls',
    );
  });

  it('emits sqlFunction calls and can inline the twin', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/fn-policy.ts'),
      `import { allow, definePolicy, principal, role, sqlFunction } from 'permdock';
import { permissions } from './permissions.ts';

const member = role('member', [
  allow(permissions.post.read, {
    where: sqlFunction('job_permitted', {
      args: [{ field: 'id' }],
      twin: { authorId: principal.id },
    }),
  }),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/fn-policy.ts',
};
`,
    );
    const generated = await run(
      ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql'],
      { cwd },
    );
    expect(generated.code).toBe(0);
    expect(generated.stdout).toContain('portable via twin');
    const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
    expect(sql).toContain('"job_permitted"("id")');
    const inlined = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--inline-functions',
        '--out',
        'inline.sql',
      ],
      { cwd },
    );
    expect(inlined.code).toBe(0);
    expect(readFileSync(join(cwd, 'inline.sql'), 'utf8')).toContain(
      '"authorId" = (select auth.uid())',
    );
  });

  it('import maps mapped functions to sqlFunction and hints on unmapped calls', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'schema.sql'),
      `create policy "jobs_read" on job for select to authenticated using (job_permitted(id));
create policy "posts_read" on post for select to authenticated using ((select auth.uid()) = "authorId");
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: {
    functions: {
      job_permitted: {
        twin: { op: 'eq', field: 'authorId', value: { ref: 'principal.id' } },
        args: ['id'],
      },
    },
  },
};
`,
    );
    const mapped = await run(
      [
        'rls',
        'import',
        '--sql',
        'schema.sql',
        '--out',
        'src/permissions.generated.ts',
      ],
      { cwd },
    );
    expect(mapped.code).toBe(0);
    const generated = readFileSync(
      join(cwd, 'src/permissions.generated.ts'),
      'utf8',
    );
    expect(generated).toContain('sqlFunction');
    expect(generated).toContain('principal.id');
  });

  it('import hints when a function is not listed in rls.functions', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'opaque.sql'),
      `create policy "jobs_read" on job for select to authenticated using (job_permitted(id));
`,
    );
    const unmapped = await run(
      [
        'rls',
        'import',
        '--sql',
        'opaque.sql',
        '--out',
        'src/opaque.generated.ts',
      ],
      { cwd },
    );
    expect(unmapped.code).toBe(0);
    expect(unmapped.stdout).toContain('rls.functions.job_permitted');
  });

  it('import maps EXISTS and IN membership subqueries to memberOf', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'members.sql'),
      `create policy "posts_read" on post for select to authenticated using (
  exists (select 1 from organization_members m where m.organization_id = "orgId")
);
create policy "posts_list" on post for select to authenticated using (
  "orgId" in (select organization_id from organization_members)
);
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: {
    memberships: {
      tenant: {
        table: 'organization_members',
        tenant: 'orgId',
        user: 'user_id',
        role: 'role',
      },
    },
  },
};
`,
    );
    const result = await run(
      [
        'rls',
        'import',
        '--sql',
        'members.sql',
        '--out',
        'src/permissions.generated.ts',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const generated = readFileSync(
      join(cwd, 'src/permissions.generated.ts'),
      'utf8',
    );
    expect(generated).toContain('"op": "memberOf"');
    expect(generated).toContain('"scope": "tenant"');
  });

  it('verify --db reports a connection failure and opaque grants as untestable', async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, 'src/opaque-policy.ts'),
      `import { allow, definePolicy, opaque, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read, {
        where: opaque({ sql: 'job_permitted(id)', fingerprint: 'x' }),
      }),
    ]),
  ],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/opaque-policy.ts',
};
`,
    );
    writeFileSync(
      join(cwd, 'rls.fixtures.json'),
      `${JSON.stringify(
        [
          {
            subject: { id: 'user-1', roles: ['member'] },
            row: { id: 'p1', authorId: 'user-1' },
            action: 'post.read',
          },
        ],
        null,
        2,
      )}\n`,
    );
    const inProcess = await run(
      ['rls', 'verify', '--fixtures', 'rls.fixtures.json'],
      { cwd },
    );
    expect(inProcess.code).toBe(0);
    expect(inProcess.stdout).toContain('untestable app-side');
    const missing = await run(
      [
        'rls',
        'verify',
        '--db',
        'postgres://permdock:permdock@127.0.0.1:1/missing',
        '--fixtures',
        'rls.fixtures.json',
      ],
      { cwd },
    );
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain('could not connect');
  });
});
