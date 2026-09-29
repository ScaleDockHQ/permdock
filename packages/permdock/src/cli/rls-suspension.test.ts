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

import { run } from './run.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, '../fixtures/named-scopes.ts');
const TMP = join(HERE, '../../tmp');

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MEMBERSHIPS = {
  scopes: {
    organization: {
      table: 'organization_users',
      user: 'user_id',
      role: 'role',
      columns: { organization: 'organization_id' },
    },
    customer: {
      table: 'customer_contacts',
      user: 'user_id',
      role: 'role',
      columns: { customer: 'customer_id', organization: 'organization_id' },
    },
  },
};

const SUSPENSION = {
  users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' },
  scopes: {
    organization: {
      table: 'organizations',
      id: 'id',
      disabledAt: 'disabled_at',
    },
    customer: {
      table: 'customers',
      id: 'id',
      status: 'status',
      active: ['active', 'prospect'],
    },
  },
};

async function generate(
  rls: Record<string, unknown>,
  extra: readonly string[] = [],
): Promise<{ code: number; output: string; sql: string }> {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'rls-suspension-'));
  temps.push(cwd);
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `export default ${JSON.stringify({ permissions: POLICY, policy: POLICY, rls })};\n`,
  );
  const result = await run(
    ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql', ...extra],
    { cwd },
  );
  let sql = '';
  try {
    sql = readFileSync(join(cwd, 'rls.sql'), 'utf8');
  } catch {
    sql = '';
  }
  return { code: result.code, output: result.stdout + result.stderr, sql };
}

function helper(sql: string, name: string): string {
  const start = sql.indexOf(`function "public".${name}(`);
  return sql.slice(start, sql.indexOf('$$;', start));
}

describe('rls.suspension', () => {
  it('checks the user and every instance on the chain in database mode', async () => {
    const { code, sql } = await generate({
      dialect: 'supabase',
      tenantType: 'text',
      authorize: 'database',
      memberships: MEMBERSHIPS,
      suspension: SUSPENSION,
    });
    expect(code).toBe(0);
    const user =
      'exists (select 1 from "public"."profiles" s where s."id" = (select auth.uid()) and s."disabled_at" is null)';
    expect(helper(sql, 'permdock_has')).toContain(user);
    const customer = helper(sql, 'permitted_customer_ids');
    expect(customer).toContain(user);
    expect(customer).toContain(
      `exists (select 1 from "public"."customers" s where s."id" = (m."customer_id")::text and s."status"::text = any(array['active', 'prospect']::text[]))`,
    );
    expect(customer).toContain(
      'exists (select 1 from "public"."organizations" s where s."id" = (m."organization_id")::text and s."disabled_at" is null)',
    );
    expect(helper(sql, 'permitted_organization_ids')).not.toContain(
      '"customers"',
    );
  });

  it('checks the claim ids against the tables in jwt mode', async () => {
    const { code, sql } = await generate({
      dialect: 'supabase',
      tenantType: 'text',
      authorize: 'jwt',
      suspension: SUSPENSION,
    });
    expect(code).toBe(0);
    const customer = helper(sql, 'permitted_customer_ids');
    expect(customer).toContain(`s."id" = (m ->> 'id')::text`);
    expect(customer).toContain(
      `s."id" = (m -> 'within' ->> 'organization')::text and s."disabled_at" is null`,
    );
  });

  it('resolves scope aliases and leaves the SQL unchanged without suspension', async () => {
    const aliased = await generate({
      dialect: 'supabase',
      tenantType: 'text',
      authorize: 'jwt',
      suspension: {
        scopes: {
          tenant: {
            table: 'organizations',
            id: 'id',
            disabledAt: 'disabled_at',
          },
        },
      },
    });
    expect(aliased.code).toBe(0);
    expect(helper(aliased.sql, 'permitted_organization_ids')).toContain(
      '"organizations"',
    );
    const plain = await generate({
      dialect: 'supabase',
      tenantType: 'text',
      authorize: 'jwt',
    });
    expect(plain.sql).not.toContain('disabled_at');
  });

  it('refuses a suspension config it cannot compile', async () => {
    const base = {
      dialect: 'supabase',
      tenantType: 'text',
      authorize: 'database',
      memberships: MEMBERSHIPS,
    };
    const unknown = await generate({
      ...base,
      suspension: {
        scopes: { site: { table: 't', id: 'id', disabledAt: 'd' } },
      },
    });
    expect(unknown.code).toBe(2);
    expect(unknown.output).toContain('rls.suspension.scopes.site');
    const neither = await generate({
      ...base,
      suspension: { users: { table: 'profiles', id: 'id' } },
    });
    expect(neither.code).toBe(2);
    expect(neither.output).toContain('disabledAt or status');
    const noActive = await generate({
      ...base,
      suspension: { users: { table: 'profiles', id: 'id', status: 'status' } },
    });
    expect(noActive.code).toBe(2);
    expect(noActive.output).toContain('rls.suspension.users.active');
    const unsafe = await generate({
      ...base,
      suspension: {
        users: { table: 'profiles', id: 'id; drop table x', disabledAt: 'd' },
      },
    });
    expect(unsafe.code).toBe(2);
    const noAncestor = await generate({
      ...base,
      memberships: {
        scopes: {
          ...MEMBERSHIPS.scopes,
          customer: {
            table: 'customer_contacts',
            user: 'user_id',
            role: 'role',
            columns: { customer: 'customer_id' },
          },
        },
      },
      suspension: {
        scopes: {
          organization: {
            table: 'organizations',
            id: 'id',
            disabledAt: 'disabled_at',
          },
        },
      },
    });
    expect(noAncestor.code).toBe(2);
    expect(noAncestor.output).toContain('columns.organization');
  });
});

describe('the Supabase token hook', () => {
  const rbac = ['--rbac', 'supabase', '--dialect', 'supabase'];

  it('writes canonical memberships from every scope table in jwt mode', async () => {
    const { code, sql, output } = await generate(
      {
        tenantType: 'text',
        authorize: 'jwt',
        memberships: MEMBERSHIPS,
        suspension: SUSPENSION,
      },
      rbac,
    );
    expect(code).toBe(0);
    expect(output).not.toContain('writes no');
    const hook = sql.slice(sql.indexOf('custom_access_token_hook'));
    expect(hook).toContain(`'scope', 'organization'`);
    expect(hook).toContain(`'scope', 'customer'`);
    expect(hook).toContain(
      `'within', jsonb_build_object('organization', m."organization_id"::text)`,
    );
    expect(hook).toContain(
      `claims := jsonb_set(claims, '{memberships}', members);`,
    );
    expect(hook).toContain(
      `if not exists (select 1 from "public"."profiles" s where s."id" = uid::uuid and s."disabled_at" is null) then`,
    );
    expect(hook).toContain(
      `claims := jsonb_set(claims, '{user_role}', '[]'::jsonb);`,
    );
    for (const table of [
      'organization_users',
      'customer_contacts',
      'organizations',
      'customers',
      'profiles',
    ]) {
      expect(hook).toContain(
        `grant select on table "public"."${table}" to supabase_auth_admin;`,
      );
    }
    expect(sql).not.toMatch(/service_role/iu);
  });

  it('writes no memberships in database mode, and warns about a table missing an ancestor', async () => {
    const database = await generate(
      { tenantType: 'text', authorize: 'database', memberships: MEMBERSHIPS },
      rbac,
    );
    expect(database.code).toBe(0);
    expect(database.sql).not.toContain('{memberships}');
    const partial = await generate(
      {
        tenantType: 'text',
        authorize: 'jwt',
        memberships: {
          scopes: {
            ...MEMBERSHIPS.scopes,
            customer: {
              table: 'customer_contacts',
              user: 'user_id',
              role: 'role',
              columns: { customer: 'customer_id' },
            },
          },
        },
      },
      rbac,
    );
    expect(partial.code).toBe(0);
    expect(partial.output).toContain(
      'the token hook writes no customer memberships',
    );
    expect(partial.sql).toContain(`'scope', 'organization'`);
    expect(partial.sql).not.toContain(`'scope', 'customer'`);
  });

  it('guards authorize() against suspended users and tenants', async () => {
    const { sql } = await generate(
      {
        tenantType: 'text',
        authorize: 'jwt',
        memberships: MEMBERSHIPS,
        suspension: SUSPENSION,
      },
      rbac,
    );
    const authorize = sql.slice(
      sql.indexOf('function "public"."authorize"('),
      sql.indexOf('function "public"."custom_access_token_hook"'),
    );
    expect(authorize).toContain('return false; -- suspended user');
    expect(authorize).toContain(
      `if requested_tenant is not null and not exists (select 1 from "public"."organizations" s where s."id"::text = requested_tenant and s."disabled_at" is null) then`,
    );
  });
});
