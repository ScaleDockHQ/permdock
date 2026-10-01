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

const SOURCES = `[
    fromTable({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at' } }),
    fromJunction({
      table: 'contacts',
      scope: 'customer',
      within: { organization: 'organization_id' },
      roles: ['contact'],
      via: 'contact',
    }),
  ]`;

async function generate(
  rls: string,
  hook?: string,
): Promise<{ code: number; output: string; sql: string }> {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, 'rls-member-'));
  temps.push(cwd);
  writeFileSync(
    join(cwd, 'permdock.config.ts'),
    `import { fromJunction, fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: ${rls},
  ${hook === undefined ? '' : `supabase: { hook: ${hook} },`}
};
`,
  );
  const result = await run(
    ['rls', 'generate', '--target', 'sql', '--out', 'rls.sql'],
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
  return start === -1 ? '' : sql.slice(start, sql.indexOf('$$;', start));
}

describe('member_<scope>_ids', () => {
  it('reads the memberships claim in jwt mode, with any role and no active-tenant narrowing', async () => {
    const { code, sql } = await generate(
      "{ dialect: 'supabase', authorize: 'jwt', tenantType: 'text' }",
    );
    expect(code).toBe(0);
    const body = helper(sql, 'member_customer_ids');
    // The helper exists and takes no permission key.
    expect(body).toContain('member_customer_ids()');
    expect(body).toContain("m ->> 'scope' = 'customer'");
    expect(body).toContain("jsonb_array_length(m -> 'roles') > 0");
    // Expired memberships stay out, as in permitted_<scope>_ids.
    expect(body).toContain("(m ->> 'expiresAt')::numeric");
    // No role_permissions join and no tenant claim: membership only.
    expect(body).not.toContain('role_permissions');
    expect(body).not.toContain('tenant_id');
    expect(sql).toContain(
      'grant execute on function "public".member_customer_ids() to authenticated;',
    );
    expect(sql).not.toContain('service_role');
  });

  it('runs the membership sources in database mode, so the helpers and the hook share SQL', async () => {
    const { code, output, sql } = await generate(
      `{ dialect: 'supabase', authorize: 'database', tenantType: 'text', suspension: { users: { table: 'profiles', id: 'user_id', disabledAt: 'disabled_at' }, scopes: { organization: { table: 'organizations', id: 'id', disabledAt: 'disabled_at' } } } }`,
      `{ memberships: ${SOURCES} }`,
    );
    expect(code).toBe(0);
    // The sources cover both scopes, so no "they deny" warning.
    expect(output).not.toContain('otherwise they deny');
    const permitted = helper(sql, 'permitted_customer_ids');
    expect(permitted).toContain('from "public"."contacts" m');
    expect(permitted).toContain('from "public"."memberships" m');
    expect(permitted).toContain("ms.scope = 'customer'");
    expect(permitted).toContain('rp.grant_key = p_grant');
    // A suspended organization voids a customer membership under it, read from the row's within.
    expect(permitted).toContain(
      `"public"."organizations" s where s."id" = (ms.within ->> 'organization')::text`,
    );
    const member = helper(sql, 'member_organization_ids');
    expect(member).toContain("ms.scope = 'organization'");
    expect(member).not.toContain('role_permissions');
    // The junction source holds only customer memberships, so it is not read for organizations.
    expect(member).not.toContain('"public"."contacts"');
    expect(member).toContain(
      `"public"."profiles" s where s."user_id" = (select auth.uid())`,
    );
  });

  it('prefers rls.membershipSources over the hook sources, and selects database mode', async () => {
    const { code, sql } = await generate(
      `{ dialect: 'supabase', tenantType: 'text', membershipSources: [fromTable({ table: 'staff' })] }`,
      `{ memberships: ${SOURCES} }`,
    );
    expect(code).toBe(0);
    const member = helper(sql, 'member_organization_ids');
    expect(member).toContain('from "public"."staff" m');
    expect(member).not.toContain('"public"."memberships"');
  });

  it('reads a mapped membership table in database mode', async () => {
    const { code, sql } = await generate(
      `{ dialect: 'supabase', authorize: 'database', tenantType: 'text', memberships: { scopes: { organization: { table: 'organization_users', user: 'user_id', role: 'role', columns: { organization: 'organization_id' }, expiresAt: 'expires_at' } } } }`,
    );
    expect(code).toBe(0);
    const member = helper(sql, 'member_organization_ids');
    expect(member).toContain(
      'select distinct m."organization_id"::text\n  from "public"."organization_users" m',
    );
    expect(member).toContain('m."expires_at" > now()');
  });
});
