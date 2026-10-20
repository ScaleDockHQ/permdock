import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { RlsCustomRoleTable } from "../../src/cli/types.ts";

import { pd072 } from "../../src/cli/doctor/rls.ts";
import { customRoleNameGuardSql } from "../../src/cli/rls/custom-role-guard.ts";
import { helpersSql } from "../../src/cli/rls/helpers.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const table = { table: "app_roles", key: "name", tenant: "organization_id" };
const guard = {
  table: "app_roles",
  tenant: "organization_id",
  declared: ["owner"],
};
const source = junctionMembershipSource({
  table: "organization_members",
  scope: "org",
  id: "organization_id",
  roles: { through: "app_roles", on: { role_id: "id" }, column: "name" },
});

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: [{ name: "org", key: "org_id" }],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    customRoles: { declared: ["owner"], assignable: [], table },
    ...extra,
  };
}

describe("a tenant row named like a declared role", () => {
  it("reads as no role through the roles table", () => {
    const guarded = source.guarded?.(guard);
    const select = guarded?.sql.select("$1") ?? "";
    expect(select).toContain(
      `case when mk."organization_id" is not null and mk."name"::text = any(array['owner']::text[]) then null else mk."name"::text end`,
    );
    expect(source.sql.select("$1")).not.toContain("is not null and mk");
  });

  it("leaves a source that reads another roles table alone", () => {
    const other = junctionMembershipSource({
      table: "organization_members",
      scope: "org",
      roles: { through: "other_roles", on: { role_id: "id" }, column: "name" },
    }).guarded?.(guard);
    expect(other?.sql.select("$1")).not.toContain("is not null and mk");
  });

  it("is refused by a before trigger on the roles table", () => {
    const sql = customRoleNameGuardSql(ctx());
    expect(sql).toContain("hint = 'declared-role'");
    expect(sql).toContain("hint = 'name-taken'");
    expect(sql).toContain(
      `create trigger "permdock_custom_role_name_guard"\n  before insert or update on "public"."app_roles"`,
    );
    expect(helpersSql(ctx(), [], { userRoles: true })).toContain(
      "permdock_custom_role_name_guard",
    );
  });

  it("emits no trigger without a tenant column", () => {
    expect(
      customRoleNameGuardSql(
        ctx({
          customRoles: {
            declared: [],
            assignable: [],
            table: { table: "r", key: "k" },
          },
        }),
      ),
    ).toBe("");
  });
});

describe("PD072", () => {
  const config = (roles: RlsCustomRoleTable) => ({
    rls: {
      membershipSources: [source],
      customRoleWrites: { roles },
    },
  });

  it("warns when a source reads keys through the tenant-writable roles table", () => {
    const findings = pd072({ cwd: ".", config: config(table) });
    expect(findings.map((finding) => finding.code)).toEqual(["PD072"]);
  });

  it("is quiet when the roles table has no tenant column or is not read", () => {
    expect(
      pd072({ cwd: ".", config: config({ table: "app_roles", key: "name" }) }),
    ).toEqual([]);
    expect(
      pd072({ cwd: ".", config: config({ ...table, table: "x" }) }),
    ).toEqual([]);
  });
});
