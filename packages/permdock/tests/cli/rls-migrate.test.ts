import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { MigrateReport } from '../../src/cli/rls-migrate.ts';

import { mapKey } from '../../src/cli/rls-migrate.ts';
import { run } from '../../src/cli/run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, '../fixtures/named-scopes.ts');
const SUPABASE = join(HERE, '../../src/supabase/index.ts');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MIGRATE = {
  helpers: {
    org_ids_with_permission: { form: 'ids', scope: 'organization' },
    has_org_permission: { form: 'row', scope: 'organization' },
    authorize_scope: { form: 'scoped' },
    is_system_user_with: { form: 'global' },
    is_org_member: { form: 'membership', scope: 'organization' },
  },
  keys: { 'organization.assets.edit': 'asset.update' },
  prefixes: { 'organization.': '', 'system.': '' },
  globalScopes: ['system'],
};

const POLICIES = `-- hand-written policies, formatting kept
create policy "assets_select" on public.asset for select to authenticated
  using (
    organization_id in (select public.org_ids_with_permission('organization.asset.update'))
    or public.is_org_member(asset.organization_id)
  );

create policy "assets_update" on public.asset for update to authenticated
  using (public.has_org_permission(asset.organization_id, 'organization.assets.edit'))
  with check (public.authorize_scope('organization', organization_id, 'organization.asset.update'));

create policy "orgs_disable" on public.organization for update to authenticated
  using ((select public.is_system_user_with('system.organization.read'))
    or public.authorize_scope('system', null, 'system.organization.read'));
`;

const UNSAFE = `create policy "computed_id" on public.asset for select to authenticated
  using (public.has_org_permission(public.current_org(), 'organization.asset.update'));

create policy "dynamic_key" on public.asset for select to authenticated
  using (organization_id in (select public.org_ids_with_permission(format('organization.%s', 'asset.read'))));

create policy "conditioned" on public.quote for select to authenticated
  using (organization_id in (select public.org_ids_with_permission('organization.quote.read')));

create policy "wrong_scope" on public.organization for update to authenticated
  using (id in (select public.org_ids_with_permission('organization.organization.read')));

create view public.my_assets as
  select * from public.asset where public.has_org_permission(organization_id, 'organization.asset.read');

create function public.can_disable() returns boolean
language sql security definer set search_path = '' as $$
  select public.is_system_user_with('system.organization.read')
$$;
`;

const UNKNOWN = `create policy "unknown" on public.asset for select to authenticated
  using (organization_id in (select public.org_ids_with_permission('organization.nope.read')));
`;

function project(files: Readonly<Record<string, string>>): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'migrate-'));
  temps.push(cwd);
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `import { fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: {
    dialect: 'supabase',
    membershipSources: [fromTable({ table: 'memberships' })],
    migrate: ${JSON.stringify(MIGRATE)},
  },
};
`,
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  return cwd;
}

const read = (cwd: string, rel: string) => readFileSync(join(cwd, rel), 'utf8');

async function report(cwd: string): Promise<MigrateReport> {
  const result = await run(
    ['rls', 'migrate', '--rbac', 'supabase', '--sql', 'supabase', '--json'],
    { cwd },
  );
  // SAFETY: --json prints runRlsMigrate's MigrateReport.
  return JSON.parse(result.stdout) as MigrateReport;
}

describe('mapKey', () => {
  it('prefers an exact key, then the longest prefix', () => {
    const config = {
      helpers: {},
      keys: { 'organization.a': 'x.y' },
      prefixes: { 'organization.': '', 'organization.billing.': 'billing.' },
    };
    expect(mapKey(config, 'organization.a')).toBe('x.y');
    expect(mapKey(config, 'organization.billing.read')).toBe('billing.read');
    expect(mapKey(config, 'organization.asset.read')).toBe('asset.read');
    expect(mapKey(config, 'asset.read')).toBe('asset.read');
  });
});

describe('rls migrate', () => {
  it('rewrites every helper form in policies and keeps the rest of the file', async () => {
    const cwd = project({ 'supabase/schemas/060_assets.sql': POLICIES });
    const dry = await run(
      ['rls', 'migrate', '--rbac', 'supabase', '--sql', 'supabase'],
      { cwd },
    );
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(
      'rls migrate: would rewrite 6 call(s) in 1 file(s), skipped 0; --write applies them',
    );
    expect(read(cwd, 'supabase/schemas/060_assets.sql')).toBe(POLICIES);

    const wrote = await run(
      ['rls', 'migrate', '--rbac', 'supabase', '--sql', 'supabase', '--write'],
      { cwd },
    );
    expect(wrote.code).toBe(0);
    expect(read(cwd, 'supabase/schemas/060_assets.sql'))
      .toBe(`-- hand-written policies, formatting kept
create policy "assets_select" on public.asset for select to authenticated
  using (
    organization_id in (select permdock.permitted_organization_ids('asset.update'))
    or (asset.organization_id in (select permdock.member_organization_ids()))
  );

create policy "assets_update" on public.asset for update to authenticated
  using ((asset.organization_id in (select permdock.permitted_organization_ids('asset.update'))))
  with check ((organization_id in (select permdock.permitted_organization_ids('asset.update'))));

create policy "orgs_disable" on public.organization for update to authenticated
  using ((select permdock.permdock_has('organization.read'))
    or (select permdock.permdock_has('organization.read')));
`);
    expect((await report(cwd)).rewrites).toEqual([]);
  });

  it('reports what it cannot rewrite safely and leaves it untouched', async () => {
    const cwd = project({ 'supabase/migrations/001_unsafe.sql': UNSAFE });
    const result = await report(cwd);
    expect(result.rewrites).toEqual([]);
    expect(
      result.skipped.map((item) => [item.line, item.reason, item.call]),
    ).toEqual([
      [
        2,
        'not-a-column',
        "public.has_org_permission(public.current_org(), 'organization.asset.update')",
      ],
      [
        5,
        'dynamic-key',
        "public.org_ids_with_permission(format('organization.%s', 'asset.read'))",
      ],
      [
        8,
        'row-conditions',
        "public.org_ids_with_permission('organization.quote.read')",
      ],
      [
        11,
        'not-granted-on-scope',
        "public.org_ids_with_permission('organization.organization.read')",
      ],
      [
        14,
        'not-in-policy',
        "public.has_org_permission(organization_id, 'organization.asset.read')",
      ],
      [18, 'function-body', 'is_system_user_with'],
    ]);
    await run(
      ['rls', 'migrate', '--rbac', 'supabase', '--sql', 'supabase', '--write'],
      { cwd },
    );
    expect(read(cwd, 'supabase/migrations/001_unsafe.sql')).toBe(UNSAFE);
  });

  it('exits 1 while a mapped key is unknown', async () => {
    const cwd = project({ 'supabase/migrations/002_unknown.sql': UNKNOWN });
    const result = await run(
      ['rls', 'migrate', '--rbac', 'supabase', '--sql', 'supabase'],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'organization.nope.read maps to nope.read, which the policy does not declare',
    );
  });

  it('needs rls.migrate and --sql', async () => {
    const cwd = project({});
    writeFileSync(
      join(cwd, 'permdock.config.ts'),
      `export default { policy: ${JSON.stringify(POLICY)}, rls: { dialect: 'supabase' } };`,
    );
    const missing = await run(['rls', 'migrate', '--sql', 'supabase'], {
      cwd,
    });
    expect(missing.code).toBe(2);
    expect(missing.stderr + missing.stdout).toContain(
      'rls migrate needs rls.migrate.helpers',
    );
  });
});

describe('rls generate --helpers-only', () => {
  it('writes the helpers and seeds, and no table policies', async () => {
    const cwd = project({});
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--rbac',
        'supabase',
        '--helpers-only',
        '--out',
        'supabase/schemas/056_permdock.sql',
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = read(cwd, 'supabase/schemas/056_permdock.sql');
    expect(sql).toContain('function "permdock".permitted_organization_ids(');
    expect(sql).toContain('function "permdock".member_organization_ids(');
    expect(sql).toContain('insert into "permdock".role_permissions');
    expect(sql).not.toMatch(/create policy/iu);
  });

  it('refuses a policies part', async () => {
    const cwd = project({});
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--helpers-only',
        '--split',
        'helpers,policies',
        '--out',
        'supabase/schemas/056_permdock_{part}.sql',
      ],
      { cwd },
    );
    expect(result.code).toBe(2);
    expect(result.stderr + result.stdout).toContain(
      'rls generate --helpers-only writes no policies part',
    );
  });
});
