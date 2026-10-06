import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import {
  accessSql,
  helpersSql,
  membershipTable,
} from "../../src/cli/rls-helpers.ts";
import { fromTable } from "../../src/supabase/index.ts";

const scopes = [
  { name: "org", key: "org_id" },
  { name: "team", key: "team_id", within: "org" },
  { name: "region", key: "region_id" },
];

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    ...extra,
  };
}

const helpers = (extra: Partial<RlsSqlContext>, userRoles = false) =>
  helpersSql(ctx(extra), [], { userRoles });

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

const teamMembers = {
  table: "app.team_members",
  user: "user_id",
  role: "role",
  columns: { team: "team_id", org: "org_id" },
};

describe("accessSql and membershipTable", () => {
  it("needs the scope column for a scoped grant", () => {
    expect(() => accessSql(ctx(), "team", "doc.read", undefined)).toThrow(
      "team-scoped grant needs definePolicy({ scopes.team })",
    );
  });

  it("keeps a schema-qualified membership table", () => {
    expect(membershipTable("app.members")).toBe('"app"."members"');
    expect(membershipTable("members")).toBe('"public"."members"');
  });
});

describe("helpersSql schema", () => {
  it("creates the private permdock schema and grants only usage", () => {
    const sql = helpers({});
    expect(sql).toContain(
      'create schema if not exists "permdock";\nrevoke all on schema "permdock" from public;\ngrant usage on schema "permdock" to authenticated;',
    );
    expect(
      helpersSql(ctx(), [], { userRoles: false, anonExecute: true }),
    ).toContain('grant usage on schema "permdock" to anon, authenticated;');
  });

  it("leaves public alone when it is configured", () => {
    expect(helpers({ schema: "public" })).not.toContain("create schema");
  });
});

describe("helpersSql scopes off the root chain", () => {
  it("does not narrow a scope outside the first scope to the active tenant (jwt)", () => {
    const sql = helpers({});
    expect(fnBody(sql, "permitted_team_ids")).toContain("->> 'tenant_id'");
    expect(fnBody(sql, "permitted_region_ids")).not.toContain(
      "->> 'tenant_id'",
    );
  });

  it("does not narrow a sourced scope outside the first scope (database)", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
    });
    expect(fnBody(sql, "permitted_region_ids")).not.toContain("is null or");
  });

  it("resolves custom roles over membership sources", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
      customRoles: { declared: ["admin"], assignable: ["admin"] },
    });
    const org = fnBody(sql, "permitted_org_ids");
    expect(org).toContain("  union\n  select (ms.id)::uuid");
    expect(org).toContain("and not (r.role = any(array['admin']::text[]))");
    expect(org).toContain(
      "c.tenant_id::text = (ms.id)::text and c.scope = 'org' and (c.scope_id is null or c.scope_id = (ms.id)::text) and c.role = r.role",
    );
    expect(org).toContain('"permdock".permdock_custom_keys(');
    const team = fnBody(sql, "permitted_team_ids");
    expect(team).toContain(
      "c.tenant_id::text = (ms.within ->> 'org')::text and c.scope = 'team'",
    );
  });
});

describe("helpersSql with rls.tenants 'all'", () => {
  it("never narrows a helper to the tenant claim, in either mode", () => {
    for (const extra of [
      {},
      {
        authorize: "database" as const,
        sources: [fromTable({ table: "memberships" })],
      },
      {
        authorize: "database" as const,
        memberships: {
          scopes: {
            org: {
              table: "org_members",
              user: "user_id",
              role: "role",
              column: "org_id",
            },
            team: { ...teamMembers, tenant: "org_id" },
          },
        },
      },
    ]) {
      const narrowed = helpers(extra);
      const all = helpers({ ...extra, tenants: "all" });
      expect(narrowed).toContain("'tenant_id'");
      expect(fnBody(all, "permitted_org_ids")).not.toContain("'tenant_id'");
      expect(fnBody(all, "permitted_team_ids")).not.toContain("'tenant_id'");
    }
  });
});

describe("helpersSql custom-role writes", () => {
  it("lifts the hand-out check through manageRoles permissions and checks nested instances", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
      customRoles: {
        declared: ["admin"],
        assignable: ["admin"],
        permissions: ["member.assign", "post.read"],
        manage: ["member.assign"],
      },
    });
    const beyond = fnBody(sql, "permdock_custom_role_beyond");
    expect(beyond).toContain(
      "rp.permission = any(array['member.assign']::text[])",
    );
    expect(beyond).toContain(
      `when 'team' then p_scope_id in (select x::text from "permdock".permitted_team_ids(rp.grant_key) x)`,
    );
    expect(beyond).not.toContain("reach");
    const guard = fnBody(sql, "permdock_custom_role_guard");
    expect(guard).toContain(
      `p_tenant::text in (select x::text from "permdock".member_org_ids() x)`,
    );
    expect(fnBody(sql, "permdock_custom_role_shape")).toContain(
      "p_scope = any(array['org', 'team', 'region']::text[])",
    );
    expect(fnBody(sql, "permdock_custom_role_entries")).toContain(
      "v_key = any(array['member.assign', 'post.read']::text[])",
    );
  });

  it("lets a global manageRoles holder write any tenant's roles and the platform's", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
      customRoles: {
        declared: ["admin"],
        assignable: ["admin"],
        permissions: ["member.assign", "post.read"],
        manage: ["member.assign"],
      },
    });
    const guard = fnBody(sql, "permdock_custom_role_guard");
    expect(guard).toContain(
      `and rp.permission = any(array['member.assign']::text[])
      and "permdock".permdock_has(rp.grant_key)`,
    );
    expect(guard).toContain("or (p_scope <> 'global' and (p_tenant::text in");
    expect(fnBody(sql, "permdock_custom_role_shape")).toContain(
      "if p_tenant is not null or p_scope_id is not null then",
    );
    const without = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
      customRoles: { declared: ["admin"], assignable: ["admin"] },
    });
    expect(fnBody(without, "permdock_custom_role_guard")).toContain(
      "\n    false\n    or (p_scope <> 'global'",
    );
  });

  it("checks a user the caller names through the _for helpers when every scope can read its memberships", () => {
    const sources = [fromTable({ table: "memberships" })];
    const sql = helpers({
      authorize: "database",
      sources,
      memberSources: sources,
      customRoles: {
        declared: ["admin"],
        assignable: ["admin"],
        manage: ["member.assign"],
      },
    });
    const guard = fnBody(sql, "permdock_custom_role_guard_for");
    expect(guard).toContain(
      `"permdock".permdock_custom_role_guard_for(p_user uuid, p_tenant`,
    );
    expect(guard).toContain("coalesce(p_user::text, '') <> ''");
    expect(guard).toContain(
      `p_tenant::text in (select x::text from "permdock".member_org_ids_for(p_user) x)`,
    );
    expect(guard).toContain(
      `"permdock".permdock_custom_role_beyond_for(p_user, p_tenant`,
    );
    expect(guard).not.toContain("auth.uid()");
    expect(fnBody(sql, "permdock_custom_role_beyond_for")).toContain(
      `"permdock".permdock_has_for(p_user, rp.grant_key)`,
    );
    expect(sql).toContain(
      `revoke execute on function "permdock".permdock_custom_role_guard_for(uuid, uuid, text, text, text) from public, anon, authenticated;`,
    );
    expect(
      helpers({
        authorize: "database",
        sources,
        customRoles: { declared: ["admin"], assignable: ["admin"] },
      }),
    ).not.toContain("permdock_custom_role_guard_for");
  });

  it("emits trusted variants that keep the definition checks and no caller check", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
      customRoles: { declared: ["admin"], assignable: ["admin"] },
    });
    for (const verb of ["replace", "rename", "delete"]) {
      const name = `permdock_trusted_${verb}_custom_role_grants`;
      const body = fnBody(sql, name);
      expect(body).toContain('perform "permdock".permdock_custom_role_shape(');
      expect(body).not.toContain("permdock_custom_role_guard");
      expect(sql).toMatch(
        new RegExp(
          `revoke execute on function "permdock"\\.${name}\\([^)]*\\) from public, anon, authenticated;`,
          "u",
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(`grant execute on function "permdock"\\.${name}\\(`, "u"),
      );
    }
    expect(
      fnBody(sql, "permdock_trusted_replace_custom_role_grants"),
    ).toContain('perform "permdock".permdock_custom_role_entries(');
  });

  it("is left out in jwt mode and without scopes", () => {
    const custom = { declared: [], assignable: [] };
    expect(helpers({ customRoles: custom })).not.toContain(
      "permdock_replace_custom_role_grants",
    );
    expect(
      helpersSql(
        { ...ctx({ authorize: "database", customRoles: custom }), scopes: [] },
        [],
        { userRoles: false },
      ),
    ).not.toContain("permdock_replace_custom_role_grants");
  });
});

describe("helpersSql database mode", () => {
  it("matches custom roles on the scope column when the table holds no tenant column", () => {
    const sql = helpers({
      authorize: "database",
      memberships: {
        scopes: {
          org: {
            table: "org_members",
            user: "user_id",
            role: "role",
            columns: { org: "org_id" },
          },
        },
      },
      customRoles: { declared: [], assignable: [] },
    });
    expect(sql).toContain('c.tenant_id::text = m."org_id"::text');
    expect(sql).toContain(`'{}'::text[]`);
  });

  it("checks a role's kinds against a constant via", () => {
    const sql = helpers({
      authorize: "database",
      memberships: {
        scopes: {
          org: {
            table: "staff_members",
            user: "user_id",
            role: "role",
            columns: { org: "org_id" },
            via: { value: "staff" },
          },
        },
      },
      ownership: { kinds: { admin: ["staff"] }, assigns: [], counted: [] },
    });
    const org = fnBody(sql, "permitted_org_ids");
    expect(org).not.toContain("coalesce");
    expect(org).not.toContain('m."via"');
    const contact = fnBody(
      helpers({
        authorize: "database",
        memberships: {
          scopes: {
            org: {
              table: "contacts",
              user: "user_id",
              role: "role",
              columns: { org: "org_id" },
              via: { value: "contact" },
            },
          },
        },
        ownership: { kinds: { admin: ["staff"] }, assigns: [], counted: [] },
      }),
      "permitted_org_ids",
    );
    expect(contact).toContain(
      `not (m."role"::text = any(array['admin']::text[]))`,
    );
  });

  it("types user_roles.user_id as text outside Supabase", () => {
    expect(helpers({ authorize: "database", dialect: "guc" }, true)).toContain(
      "  user_id text not null,",
    );
    expect(helpers({ authorize: "database" }, true)).toContain(
      "  user_id uuid not null references auth.users on delete cascade,",
    );
  });

  it("needs the ancestor column to check a suspended ancestor", () => {
    expect(() =>
      helpers({
        authorize: "database",
        memberships: {
          scopes: { team: { ...teamMembers, columns: { team: "team_id" } } },
        },
        suspension: {
          scopes: {
            org: { table: "orgs", id: "id", disabledAt: "disabled_at" },
          },
        },
      }),
    ).toThrow("rls.suspension.scopes.org needs the org id on team memberships");
  });

  it("checks a suspended ancestor through its column", () => {
    const sql = helpers({
      authorize: "database",
      memberships: { scopes: { team: teamMembers } },
      suspension: {
        scopes: { org: { table: "orgs", id: "id", disabledAt: "disabled_at" } },
      },
    });
    expect(fnBody(sql, "member_team_ids")).toContain(
      's."id" = (m."org_id")::uuid',
    );
  });
});
