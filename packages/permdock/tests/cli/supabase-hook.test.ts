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

import type { SupabaseHookManifest } from '../../src/supabase/manifest.ts';

import { run } from '../../src/cli/run.ts';
import { subjectFromSupabase } from '../../src/supabase/index.ts';

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

const SOURCES = `fromTable({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at', managedBy: 'managed_by', seats: 'seats' } }),
    fromJunction({
      table: 'customer_contacts',
      scope: 'customer',
      within: { organization: 'organization_id' },
      roles: ['contact'],
      via: 'contact',
    }),`;

async function generate(
  hook: string,
  extra: readonly string[] = [],
  rls = '{}',
): Promise<{ code: number; output: string; sql: string; cwd: string }> {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'supabase-hook-'));
  temps.push(cwd);
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `import { fromJunction, fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: ${rls},
  supabase: { hook: ${hook} },
};
`,
  );
  const result = await run(
    ['supabase', 'hook', 'generate', '--out', 'hook.sql', ...extra],
    { cwd },
  );
  let sql = '';
  try {
    sql = readFileSync(join(cwd, 'hook.sql'), 'utf8');
  } catch {
    sql = '';
  }
  return {
    code: result.code,
    output: result.stdout + result.stderr,
    sql,
    cwd,
  };
}

describe('permdock supabase hook generate', () => {
  it('emits the hook, the grants, the version table and the config.toml block', async () => {
    const { code, output, sql } = await generate(
      `{ memberships: [${SOURCES}], attrs: { table: 'profiles', columns: ['locale', 'timezone', 'app_metadata.plan'] } }`,
    );
    expect(code).toBe(0);
    expect(output).toContain('jwt_expiry = 900');
    expect(output).toContain(
      'uri = "pg-functions://postgres/permdock/custom_access_token_hook"',
    );
    expect(sql).toContain(
      'create schema if not exists "permdock";\nrevoke all on schema "permdock" from public;\n\ncreate or replace function "permdock".custom_access_token_hook(event jsonb)',
    );
    expect(sql).toContain(`claims -> 'app_metadata' ->> 'active_organization'`);
    expect(sql).toContain('budget integer := 1024;');
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);`,
    );
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));`,
    );
    expect(sql).toContain(`'locale', to_jsonb(p."locale")`);
    expect(sql).toContain(`'plan', claims -> 'app_metadata' -> 'plan'`);
    expect(sql).toContain(
      `where has_column_privilege(r.role, '"public"."profiles"', c.name, 'INSERT')`,
    );
    expect(sql).toContain('+ used > budget');
    expect(sql).not.toMatch(/user_meta/iu);
    expect(sql).toContain(`from "public"."customer_contacts" m`);
    expect(sql).toContain(`jsonb_build_array('contact')`);
    expect(sql).toContain(
      'create table if not exists "permdock"."permdock_authz_version"',
    );
    expect(sql).toContain('create trigger "permdock_authz_version"');
    expect(sql).toContain('create trigger "permdock_protect_managed"');
    expect(sql).toContain(
      'revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;',
    );
    for (const table of [
      '"public"."memberships"',
      '"public"."customer_contacts"',
      '"permdock"."user_roles"',
      '"public"."profiles"',
    ]) {
      expect(sql).toContain(
        `grant select on table ${table} to supabase_auth_admin;`,
      );
    }
    expect(sql).toContain(
      'create or replace function "permdock".permdock_bump_authz_version_for(p_users uuid[])',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_bump_authz_version_for(uuid[]) from public, anon, authenticated;',
    );
    expect(sql).not.toMatch(/grant execute on function [^;]*_for\(uuid\[\]\)/u);
    expect(sql).not.toMatch(/service_role/iu);
  });

  it('takes --active-from, --budget and --check', async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], version: false }`,
      ['--active-from', 'profiles.active_org', '--budget', '2048'],
    );
    expect(code).toBe(0);
    expect(sql).toContain(
      `(select a."active_org"::text from "public"."profiles" a where a."id" = v_active_user)`,
    );
    expect(sql).toContain(
      `v_active_user "public"."profiles"."id"%type := uid;`,
    );
    expect(sql).toContain('budget integer := 2048;');
    expect(sql).not.toContain('permdock_authz_version');
    const meta = await generate(`{ memberships: [${SOURCES}] }`, [
      '--active-from',
      'app_metadata.org',
    ]);
    expect(meta.sql).toContain(`claims -> 'app_metadata' ->> 'org'`);
  });

  it('refuses configurations it cannot compile', async () => {
    expect((await generate('undefined')).code).toBe(2);
    expect((await generate('{ memberships: [] }')).output).toContain(
      'at least one',
    );
    const orphan = await generate(
      `{ memberships: [fromJunction({ table: 'customer_contacts', scope: 'customer', roles: ['contact'] })] }`,
    );
    expect(orphan.code).toBe(2);
    expect(orphan.output).toContain('within columns for organization');
    const undeclared = await generate(
      `{ memberships: [fromJunction({ table: 't', scope: 'site', roles: ['x'] })] }`,
    );
    expect(undeclared.output).toContain("scope 'site'");
    expect(
      (await generate(`{ memberships: [${SOURCES}] }`, ['--budget', '0'])).code,
    ).toBe(2);
    expect(
      (
        await generate(`{ memberships: [${SOURCES}] }`, [
          '--active-from',
          'nodot',
        ])
      ).code,
    ).toBe(2);
    expect(
      (await generate(`{ memberships: [fromTable({ table: 'x; drop' })] }`))
        .code,
    ).toBe(2);
  });

  it('refuses attrs that are not server-owned', async () => {
    const attrs = async (value: string) =>
      generate(`{ memberships: [${SOURCES}], attrs: ${value} }`);
    for (const [value, message] of [
      [`{ table: 'profiles', columns: ['user_metadata'] }`, 'user-editable'],
      [
        `{ table: 'profiles', columns: ['raw_user_meta_data'] }`,
        'user-editable',
      ],
      [`{ columns: ['user_metadata.region'] }`, 'user-editable'],
      [`{ table: 'auth.users', columns: ['email'] }`, 'auth.users'],
      [`{ table: 'profiles', columns: ['__proto__'] }`, 'prototype key'],
      [
        `{ table: 'profiles', columns: ['region', 'app_metadata.region'] }`,
        'twice',
      ],
      [`{ columns: ['region'] }`, 'without a table'],
    ] as const) {
      const result = await attrs(value);
      expect(result.code).toBe(2);
      expect(result.output).toContain(message);
    }
    const meta = await attrs(`{ columns: ['app_metadata.plan'] }`);
    expect(meta.code).toBe(0);
    expect(meta.sql).not.toContain('has_column_privilege');
  });

  it('gives suspended users empty claims', async () => {
    const { sql } = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ suspension: { users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' } } }`,
    );
    expect(sql).toContain(
      `claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);`,
    );
  });

  it('writes extra claims outside the budget and strips them for suspended users', async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'better_supabase.feature_claims' } }`,
      [],
      `{ suspension: { users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' } } }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain(`extra := "better_supabase"."feature_claims"(uid);`);
    expect(sql).toContain(`claims := jsonb_set(claims, '{features}', extra);`);
    expect(sql).toContain(
      `claims := claims - 'memberships_truncated' - 'attrs' - 'tenant_id' - 'features';`,
    );
    expect(sql).toContain(`claims := claims - 'attrs' - 'features';`);
    expect(sql).toContain(
      'grant execute on function "better_supabase"."feature_claims"(uuid) to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'grant usage on schema "better_supabase" to supabase_auth_admin;',
    );
    const suspendedBranch = sql.slice(
      sql.indexOf('if not '),
      sql.indexOf('end if;', sql.indexOf('if not ')),
    );
    expect(suspendedBranch).not.toContain('feature_claims');
    const loopEnd = sql.indexOf('end loop;');
    expect(sql.indexOf('feature_claims"(uid')).toBeGreaterThan(loopEnd);
    expect(sql.split('\n', 1)[0]).toBe(
      '-- permdock:hook v1 schema=permdock tenant=tenant_id budget=1024 claims=user_role,roles,memberships,memberships_truncated,tenant_id,authz_ver,features',
    );
  });

  it('checks the marker line and prints the inspect manifest', async () => {
    const { code, cwd } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'better_supabase.feature_claims' } }`,
      ['--budget', '2048'],
    );
    expect(code).toBe(0);
    const upToDate = await run(
      [
        'supabase',
        'hook',
        'generate',
        '--out',
        'hook.sql',
        '--budget',
        '2048',
        '--check',
      ],
      { cwd },
    );
    expect(upToDate.code).toBe(0);
    const drift = await run(
      ['supabase', 'hook', 'generate', '--out', 'hook.sql', '--check'],
      { cwd },
    );
    expect(drift.code).toBe(1);
    expect(drift.stdout + drift.stderr).toContain('budget 2048 -> 1024');
    const otherSchema = await run(
      [
        'supabase',
        'hook',
        'generate',
        '--out',
        'hook.sql',
        '--budget',
        '2048',
        '--schema',
        'auth_hooks',
        '--check',
      ],
      { cwd },
    );
    expect(otherSchema.code).toBe(1);
    expect(otherSchema.stdout + otherSchema.stderr).toContain(
      'schema permdock -> auth_hooks',
    );
    writeFileSync(join(cwd, 'hook.sql'), '-- hand edited\n');
    const unmarked = await run(
      ['supabase', 'hook', 'generate', '--out', 'hook.sql', '--check'],
      { cwd },
    );
    expect(unmarked.stdout + unmarked.stderr).toContain(
      'hook.sql has no -- permdock:hook v1 line',
    );
    const inspect = await run(['supabase', 'inspect', '--json'], { cwd });
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      $schema: 'https://permdock.dev/schemas/supabase-manifest-v1.json',
      version: 1,
      hook: {
        schema: 'permdock',
        function: 'custom_access_token_hook',
        out: 'supabase/permdock-hook.sql',
      },
      helpers: {
        schema: 'permdock',
        functions: [
          'permdock_has',
          'permitted_organization_ids',
          'member_organization_ids',
          'member_organization_ids_for',
          'permitted_customer_ids',
          'member_customer_ids',
          'member_customer_ids_for',
        ],
      },
      tenantClaim: 'tenant_id',
      budget: {
        bytes: 1024,
        measure: 'octet_length(memberships::text) + octet_length(attrs::text)',
      },
      claims: [
        { name: 'user_role', source: 'permdock', budget: false },
        { name: 'roles', source: 'permdock', budget: false },
        { name: 'memberships', source: 'permdock', budget: true },
        { name: 'memberships_truncated', source: 'permdock', budget: false },
        { name: 'tenant_id', source: 'permdock', budget: false },
        { name: 'authz_ver', source: 'permdock', budget: false },
        {
          name: 'features',
          source: 'better_supabase.feature_claims',
          budget: false,
        },
      ],
      authzVersion: true,
      authzVersionBump: {
        schema: 'permdock',
        function: 'permdock_bump_authz_version_for',
        args: 'p_users uuid[]',
      },
      markers: { hook: 'v1', grants: 'v1' },
    });
    const text = await run(['supabase', 'inspect'], { cwd });
    expect(text.stdout).toContain('tenant claim tenant_id');
  });

  it('lists the membership sources, the rls helpers and the deciding columns', async () => {
    const { cwd } = await generate(
      `{ memberships: [${SOURCES}], attrs: { table: 'profiles', columns: ['locale', 'app_metadata.region'] }, claims: { features: 'better_supabase.feature_claims' } }`,
      [],
      `{ tenantType: 'text', scopeTypes: { customer: 'bigint' } }`,
    );
    const inspect = await run(['supabase', 'inspect', '--json'], { cwd });
    const manifest: unknown = JSON.parse(inspect.stdout);
    expect(manifest).toMatchObject({
      memberships: [
        {
          table: 'public.memberships',
          user: { column: 'user_id' },
          scope: { column: 'scope' },
          id: { column: 'scope_id' },
          role: { column: 'role' },
          via: { column: 'via' },
          expiresAt: { column: 'expires_at' },
          columns: [
            'user_id',
            'scope',
            'scope_id',
            'role',
            'via',
            'expires_at',
          ],
        },
        {
          table: 'public.customer_contacts',
          scope: { value: 'customer' },
          id: { column: 'customer_id' },
          role: { value: ['contact'] },
          within: { columns: { organization: 'organization_id' } },
          via: { value: 'contact' },
          columns: ['user_id', 'customer_id', 'organization_id'],
        },
      ],
      rls: {
        schema: 'permdock',
        mode: 'jwt',
        tenantClaim: 'tenant_id',
        scopes: [
          { name: 'organization', type: 'text' },
          { name: 'customer', type: 'bigint', within: 'organization' },
        ],
      },
      decidingColumns: [
        'public.customer_contacts.customer_id',
        'public.customer_contacts.organization_id',
        'public.customer_contacts.user_id',
        'public.memberships.expires_at',
        'public.memberships.role',
        'public.memberships.scope',
        'public.memberships.scope_id',
        'public.memberships.user_id',
        'public.memberships.via',
        'public.profiles.locale',
      ],
    });
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('inspect --json printed no object');
    }
    expect(Reflect.get(Reflect.get(manifest, 'rls'), 'helpers')).toContainEqual(
      {
        name: 'member_customer_ids_for',
        args: 'p_user uuid',
        returns: 'setof bigint',
        execute: ['supabase_auth_admin'],
      },
    );
  });

  it('reads the mode from rls.authorize and rls.membershipSources', async () => {
    const database = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ authorize: 'database' }`,
    );
    const inspect = await run(['supabase', 'inspect', '--json'], {
      cwd: database.cwd,
    });
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      rls: { mode: 'database' },
    });
  });

  it('lists the membership sources behind member_<scope>_ids_for in rls.memberships', async () => {
    const hookOnly = await generate(`{ memberships: [${SOURCES}] }`);
    const fromHook: SupabaseHookManifest = JSON.parse(
      (await run(['supabase', 'inspect', '--json'], { cwd: hookOnly.cwd }))
        .stdout,
    );
    expect(fromHook.rls.memberships).toEqual(fromHook.memberships);

    const mapped = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{
        memberships: {
          scopes: {
            organization: { table: 'org.members', user: 'member_id', role: 'role', columns: { organization: 'org_id' }, expiresAt: 'ends_at' },
          },
        },
        membershipSources: [
          fromJunction({ table: 'customer_contacts', scope: 'customer', within: { organization: 'organization_id' }, roles: ['contact'] }),
        ],
      }`,
    );
    const inspect = await run(['supabase', 'inspect', '--json'], {
      cwd: mapped.cwd,
    });
    expect(inspect.code).toBe(0);
    const manifest: SupabaseHookManifest = JSON.parse(inspect.stdout);
    expect(manifest.rls.memberships).toEqual([
      {
        table: 'org.members',
        user: { column: 'member_id' },
        scope: { value: 'organization' },
        id: { column: 'org_id' },
        role: { column: 'role' },
        expiresAt: { column: 'ends_at' },
        columns: ['member_id', 'org_id', 'role', 'ends_at'],
      },
      {
        table: 'public.customer_contacts',
        user: { column: 'user_id' },
        scope: { value: 'customer' },
        id: { column: 'customer_id' },
        role: { value: ['contact'] },
        within: { columns: { organization: 'organization_id' } },
        columns: ['user_id', 'customer_id', 'organization_id'],
      },
    ]);
  });

  it('writes the manifest with --out and reports drift with --check', async () => {
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const out = ['supabase', 'inspect', '--out', 'permdock.manifest.json'];
    const missing = await run([...out, '--check'], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('missing permdock.manifest.json');
    const wrote = await run(out, { cwd });
    expect(wrote.code).toBe(0);
    expect(wrote.stdout).toContain('wrote permdock.manifest.json');
    const path = join(cwd, 'permdock.manifest.json');
    const written: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const inspect = await run(['supabase', 'inspect', '--json'], { cwd });
    expect(written).toEqual(JSON.parse(inspect.stdout));
    writeFileSync(path, JSON.stringify(written));
    expect((await run([...out, '--check'], { cwd })).code).toBe(0);
    writeFileSync(
      path,
      JSON.stringify(
        Object.assign(new Object(written), { tenantClaim: 'org_id' }),
      ),
    );
    const drift = await run([...out, '--check'], { cwd });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toContain('differs in tenantClaim');
  });

  it('defaults --out and --check to permdock.manifest.json', async () => {
    const { cwd } = await generate(`{ memberships: [${SOURCES}] }`);
    const missing = await run(['supabase', 'inspect', '--check'], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('missing permdock.manifest.json');
    const wrote = await run(['supabase', 'inspect', '--out'], { cwd });
    expect(wrote.stdout).toContain('wrote permdock.manifest.json');
    const inspect = await run(['supabase', 'inspect', '--json'], { cwd });
    expect(
      JSON.parse(readFileSync(join(cwd, 'permdock.manifest.json'), 'utf8')),
    ).toEqual(JSON.parse(inspect.stdout));
    const check = await run(['supabase', 'inspect', '--out', '--check'], {
      cwd,
    });
    expect(check).toMatchObject({ code: 0 });
    expect(check.stdout).toContain('supabase manifest up to date');
  });

  it('warns with PD039 until the helpers exist in the configured schema', async () => {
    const missing = await generate(`{ memberships: [${SOURCES}] }`);
    expect(missing.code).toBe(0);
    expect(missing.output).toContain(
      'PD039 schema permdock has no permdock_has, permitted_organization_ids, member_organization_ids, member_organization_ids_for, permitted_customer_ids, member_customer_ids, member_customer_ids_for',
    );
    writeFileSync(
      join(missing.cwd, 'rls.sql'),
      `create or replace function "permdock".permdock_has(p_grant text) returns boolean language sql as $$ select false $$;
create or replace function permdock.permitted_organization_ids(p_grant text) returns setof text language sql as $$ select null::text where false $$;
create or replace function "permdock".member_organization_ids_for(p_user uuid) returns setof text language sql as $$ select null::text where false $$;
`,
    );
    const partial = await run(
      ['supabase', 'hook', 'generate', '--out', 'hook.sql'],
      { cwd: missing.cwd },
    );
    expect(partial.stdout).toContain(
      'PD039 schema permdock has no member_organization_ids, permitted_customer_ids, member_customer_ids, member_customer_ids_for',
    );
    const other = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      "{ schema: 'app' }",
    );
    writeFileSync(
      join(other.cwd, 'rls.sql'),
      `create function "permdock".permdock_has(p_grant text) returns boolean language sql as $$ select false $$;`,
    );
    const wrongSchema = await run(
      ['supabase', 'hook', 'generate', '--out', 'hook.sql'],
      { cwd: other.cwd },
    );
    expect(wrongSchema.stdout).toContain(
      'PD039 schema app has no permdock_has',
    );
  });

  it('doctor PD039 reports missing helpers, oversized extra claims and dropped memberships', async () => {
    const { cwd } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'better_supabase.feature_claims' } }`,
      [],
      "{}, doctor: { claims: './claims.json' }",
    );
    writeFileSync(
      join(cwd, 'claims.json'),
      JSON.stringify([
        { features: { small: true } },
        { features: { flags: 'x'.repeat(2000) } },
        {
          memberships: [
            { scope: 'organization', id: 'o1', roles: ['admin'] },
            { org_id: 'o2', role: 'admin' },
          ],
        },
      ]),
    );
    const result = await run(['doctor', '--json', '--only', 'PD039'], { cwd });
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {
        readonly code: string;
        readonly message: string;
      }[];
    };
    expect(report.findings.map((item) => item.message)).toEqual([
      "schema permdock has no permdock_has, permitted_organization_ids, member_organization_ids, member_organization_ids_for, permitted_customer_ids, member_customer_ids, member_customer_ids_for: the hook's claims are read by these helpers; run permdock rls generate and apply its migration",
      'claim features is 2012 bytes of JSON in ./claims.json, more than the 1024-byte memberships budget',
      'sample 2 in ./claims.json has memberships [1] that subjectFromSupabase drops (membership-dropped)',
    ]);
  });

  it('quotes a schema-qualified fromJunction table and grants usage on its schema', async () => {
    const { code, sql } = await generate(
      `{ memberships: [fromJunction({ table: 'better_supabase.memberships', scope: 'organization', id: 'org_id', roles: 'role' })], roles: false }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain('from "better_supabase"."memberships"');
    expect(sql).not.toContain('"better_supabase.memberships"');
    expect(sql).toContain(
      'grant usage on schema "better_supabase" to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'grant select on table "better_supabase"."memberships" to supabase_auth_admin;',
    );
  });

  it('refuses reserved or unqualified extra claims', async () => {
    for (const [claims, message] of [
      [`{ memberships: 'x.f' }`, 'PermDock or Supabase Auth writes'],
      [`{ tenant_id: 'x.f' }`, 'PermDock or Supabase Auth writes'],
      [`{ role: 'x.f' }`, 'PermDock or Supabase Auth writes'],
      [`{ __proto__x: 'x.f', ['__proto__']: 'x.f' }`, 'prototype key'],
      [`{ features: 'feature_claims' }`, 'schema-qualified'],
      [`{ features: 'x.f(); drop' }`, 'schema-qualified'],
    ] as const) {
      const result = await generate(
        `{ memberships: [${SOURCES}], claims: ${claims} }`,
      );
      expect(result.code).toBe(2);
      expect(result.output).toContain(message);
    }
  });
});

describe('subjectFromSupabase and the hook claims', () => {
  it('keeps via, expiresAt, owner and seats, and reads truncation and authz_ver', () => {
    const subject = subjectFromSupabase({
      sub: 'u_1',
      role: 'authenticated',
      memberships: [
        {
          scope: 'organization',
          id: 'T',
          roles: ['member'],
          via: 'staff',
          expiresAt: 1_900_000_000,
          managedBy: 'idp',
          entitlements: ['dev-mode'],
        },
      ],
      memberships_truncated: true,
      authz_ver: 4,
    });
    expect(subject.principal).toMatchObject({
      memberships: [
        {
          scope: 'organization',
          id: 'T',
          roles: ['member'],
          via: 'staff',
          expiresAt: 1_900_000_000,
          managedBy: 'idp',
          entitlements: ['dev-mode'],
        },
      ],
      membershipsTruncated: true,
      authzVersion: 4,
    });
    const plain = subjectFromSupabase({
      sub: 'u_1',
      role: 'authenticated',
      memberships_truncated: 'yes',
      authz_ver: 1.5,
    });
    expect(plain.principal?.membershipsTruncated).toBeUndefined();
    expect(plain.principal?.authzVersion).toBeUndefined();
  });
});
