import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { rolesTableScope } from "../../src/cli/rls/custom-roles.ts";
import { helpersSql } from "../../src/cli/rls/helpers.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

const column = (name: string): string => `r."${name}"`;

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: [
      { name: "org", key: "org_id" },
      { name: "team", key: "team_id", within: "org" },
    ],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    sources: [tableMembershipSource({ table: "memberships" })],
    customRoles: { declared: ["admin"], assignable: ["admin"] },
    ...extra,
  };
}

describe("rolesTableScope", () => {
  it("reads a row with no tenant as a platform role without a shared column", () => {
    expect(
      rolesTableScope({ table: "roles", key: "key" }, "t", "org", column),
    ).toBe("case when t is null then 'global' else 'org' end");
  });

  it("reads a marked row with no tenant as a shared role at its scope", () => {
    expect(
      rolesTableScope(
        { table: "roles", key: "key", shared: "shared" },
        "t",
        "org",
        column,
      ),
    ).toBe(
      `case when t is null then case when coalesce(r."shared", false) then 'org' else 'global' end else 'org' end`,
    );
    expect(
      rolesTableScope(
        { table: "roles", key: "key", shared: "shared", scope: "scope" },
        "t",
        "org",
        column,
      ),
    ).toBe(
      `case when t is null then case when coalesce(r."shared", false) then r."scope"::text else 'global' end else r."scope"::text end`,
    );
  });
});

describe("shared custom roles in the helpers", () => {
  it("emits permdock_is_shared_role in database mode only", () => {
    const database = helpersSql(ctx({ authorize: "database" }), [], {
      userRoles: true,
    });
    expect(database).toContain(
      'create or replace function "permdock".permdock_is_shared_role(p_scope text, p_role text)',
    );
    expect(database).toContain(
      `revoke execute on function "permdock".permdock_is_shared_role(text, text) from public, anon, authenticated;`,
    );
    const jwt = helpersSql(ctx({ authorize: "jwt" }), [], { userRoles: true });
    expect(jwt).not.toContain("permdock_is_shared_role");
  });

  it("refuses a tenant role named like a shared one, and a shared role at an instance", () => {
    const sql = helpersSql(ctx({ authorize: "database" }), [], {
      userRoles: true,
    });
    expect(sql).toContain(
      `if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_role) then`,
    );
    expect(sql).toContain(
      `if p_tenant is not null and "permdock".permdock_is_shared_role(p_scope, p_to) then`,
    );
    expect(sql).toContain("a shared custom role has no instance");
  });
});
