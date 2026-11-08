import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { grantBodies, helpersSql } from "../../src/cli/rls/helpers.ts";

const mapped = {
  table: "org_members",
  user: "user_id",
  role: "role",
  columns: { org: "org_id" },
} as const;

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: [{ name: "org", key: "org_id" }],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    memberships: { scopes: { org: mapped } },
    ...extra,
  };
}

const rows = [
  {
    role: "admin",
    permission: "doc.read",
    grantKey: "doc.read",
    scope: "org",
    effect: "allow",
  },
  {
    role: "admin",
    permission: "doc.edit",
    grantKey: "doc.edit",
    scope: "org",
    effect: "allow",
  },
  {
    role: "support",
    permission: "doc.read",
    grantKey: "doc.read",
    scope: "global",
    effect: "allow",
  },
] as const;

function body(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

describe("seeds: 'view' reads grant keys from a jsonb map", () => {
  const view = helpersSql(ctx({ seeds: "view" }), rows, { userRoles: true });

  it("writes the map once, by scope and role", () => {
    expect(view).toContain(
      `create or replace function "permdock".permdock_role_keys(p_scope text, p_role text)`,
    );
    expect(view).toContain(
      `select '{"global":{"support":["doc.read"]},"org":{"admin":["doc.edit","doc.read"]}}'::jsonb -> p_scope -> p_role`,
    );
    expect(view).toContain(
      `revoke execute on function "permdock".permdock_role_keys(text, text) from public, anon, authenticated;`,
    );
  });

  it("looks a key up in the map in permdock_has and permitted_<scope>_ids", () => {
    const has = body(view, "permdock_has");
    expect(has).toContain(
      `jsonb_exists("permdock".permdock_role_keys('global', ur.role::text), p_grant)`,
    );
    expect(has).not.toContain("role_permissions");
    const ids = body(view, "permitted_org_ids");
    expect(ids).toContain(
      `jsonb_exists("permdock".permdock_role_keys('org', m."role"::text), p_grant)`,
    );
    expect(ids).not.toMatch(/join "permdock"\.role_permissions/u);
  });

  it("lists a grant key once for a role that holds it as an allow and a deny", () => {
    const sql = helpersSql(
      ctx({ seeds: "view" }),
      [...rows, { ...rows[0], effect: "deny" }],
      { userRoles: true },
    );
    expect(sql).toContain(`"org":{"admin":["doc.edit","doc.read"]}`);
  });

  it("keeps the join without the view", () => {
    const table = helpersSql(ctx(), rows, { userRoles: true });
    expect(table).not.toContain("permdock_role_keys");
    expect(body(table, "permdock_has")).toContain("role_permissions");
  });
});

describe("custom roles in the helpers", () => {
  const team = {
    table: "team_members",
    user: "user_id",
    role: "role",
    columns: { org: "org_id", team: "team_id" },
  } as const;
  const nested = (extra: Partial<RlsSqlContext>): RlsSqlContext =>
    ctx({
      scopes: [
        { name: "org", key: "org_id" },
        { name: "team", key: "team_id", within: "org" },
      ],
      memberships: { scopes: { org: mapped, team } },
      customRoles: { declared: ["admin"], assignable: [] },
      ...extra,
    });

  it("matches the tenant of a role held on a sub-scope by the tenant column", () => {
    const ids = grantBodies(nested({})).ids("team").sql;
    expect(ids).toContain(
      `(not pdk_s.shared and c.tenant_id = (m."org_id")::uuid or pdk_s.shared and c.tenant_id is null)`,
    );
    expect(ids).toContain(`c.scope_id = m."team_id"::text`);
    const listed = grantBodies({ ...nested({}), grantSet: true }).ids(
      "team",
    ).sql;
    expect(listed).toContain(`c.tenant_id = (m."org_id")::uuid`);
  });

  const custom = { declared: ["admin"], assignable: [] };

  it("reads one compiled row per membership when one grant key is asked", () => {
    const ids = grantBodies(ctx({ customRoles: custom })).ids("org").sql;
    expect(ids).toContain("with pdk_m as (");
    expect(ids).toContain("where p_grant = any(pdk_m.keys)");
    expect(ids).not.toContain("permdock_custom_keys");
    expect(ids.match(/permdock_is_shared_role\(/gu)).toHaveLength(1);
  });

  it("probes per membership when the grant keys are listed", () => {
    const ids = grantBodies({
      ...ctx({ customRoles: custom }),
      grantSet: true,
    }).ids("org").sql;
    expect(ids).not.toContain("with pdk_m as (");
    expect(ids).toContain("unnest(pdk_e.keys)");
    expect(ids).toContain(") ck(grant_key)");
  });
});
