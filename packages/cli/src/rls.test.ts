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

  it('generates SQL without service_role and compiles subject.id', async () => {
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
    const sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
    expect(sql).toContain('custom_access_token_hook');
    expect(sql).toContain('create or replace function public.authorize(');
    expect(sql).toContain('requested_tenant uuid default null');
    expect(sql).toContain('user_roles');
    expect(sql).toContain('role_permissions');
    expect(sql).toContain("(select authorize('post.read'))");
    expect(sql).not.toMatch(/service_role/i);
  });

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
    expect(generated).toContain('subject.id');
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
});
