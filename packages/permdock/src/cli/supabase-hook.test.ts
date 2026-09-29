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

import { subjectFromSupabase } from '../supabase/index.ts';
import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, '../fixtures/named-scopes.ts');
const SUPABASE = join(HERE, '../supabase/index.ts');
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
): Promise<{ code: number; output: string; sql: string }> {
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
  return { code: result.code, output: result.stdout + result.stderr, sql };
}

describe('permdock supabase hook generate', () => {
  it('emits the hook, the grants, the version table and the config.toml block', async () => {
    const { code, output, sql } = await generate(
      `{ memberships: [${SOURCES}], profile: { table: 'profiles', columns: ['locale', 'timezone'] } }`,
    );
    expect(code).toBe(0);
    expect(output).toContain('jwt_expiry = 900');
    expect(output).toContain(
      'uri = "pg-functions://postgres/public/custom_access_token_hook"',
    );
    expect(sql).toContain(
      'create or replace function "public".custom_access_token_hook(event jsonb)',
    );
    expect(sql).toContain(
      `(select u.raw_app_meta_data ->> 'active_organization' from auth.users u where u.id = uid::uuid)`,
    );
    expect(sql).toContain('budget integer := 1024;');
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);`,
    );
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));`,
    );
    expect(sql).toContain(`'locale', to_jsonb(p."locale")`);
    expect(sql).toContain(`from "public"."customer_contacts" m`);
    expect(sql).toContain(`jsonb_build_array('contact')`);
    expect(sql).toContain(
      'create table if not exists "public"."permdock_authz_version"',
    );
    expect(sql).toContain('create trigger "permdock_authz_version"');
    expect(sql).toContain('create trigger "permdock_protect_managed"');
    expect(sql).toContain(
      'revoke execute on function "public".custom_access_token_hook(jsonb) from authenticated, anon, public;',
    );
    for (const table of [
      'memberships',
      'customer_contacts',
      'user_roles',
      'profiles',
    ]) {
      expect(sql).toContain(
        `grant select on table "public"."${table}" to supabase_auth_admin;`,
      );
    }
    expect(sql).not.toMatch(/service_role/iu);
  });

  it('takes --active-from, --budget and --check', async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], version: false }`,
      ['--active-from', 'profiles.active_org', '--budget', '2048'],
    );
    expect(code).toBe(0);
    expect(sql).toContain(
      `(select a."active_org"::text from "public"."profiles" a where a."id"::text = uid)`,
    );
    expect(sql).toContain('budget integer := 2048;');
    expect(sql).not.toContain('permdock_authz_version');
    const meta = await generate(`{ memberships: [${SOURCES}] }`, [
      '--active-from',
      'app_metadata.org',
    ]);
    expect(meta.sql).toContain(`raw_app_meta_data ->> 'org'`);
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
