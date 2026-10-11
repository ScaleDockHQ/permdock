import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { globalRolesSql } from "../../src/cli/rls/global-roles.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "uuid",
  authorize: "database",
};

describe("permdock_replace_global_roles", () => {
  it("writes nothing without rls.roles", () => {
    expect(globalRolesSql(base)).toBe("");
  });

  it("replaces the roles of a role key column as the invoker", () => {
    const sql = globalRolesSql({
      ...base,
      roles: { table: "platform_roles", user: "profile_id", role: "name" },
    });
    expect(sql).toContain(
      `create or replace function "permdock".permdock_replace_global_roles(p_user uuid, p_roles text[])`,
    );
    expect(sql).not.toContain("security definer");
    expect(sql).toContain(
      `delete from "public"."platform_roles" t\n  where t."profile_id" = p_user\n    and t."name"::text <> all(coalesce(p_roles, '{}'::text[]));`,
    );
    expect(sql).toContain(
      `insert into "public"."platform_roles" ("profile_id", "name")`,
    );
    expect(sql).toContain(
      `revoke execute on function "permdock".permdock_replace_global_roles(uuid, text[]) from public, anon;\ngrant execute on function "permdock".permdock_replace_global_roles(uuid, text[]) to authenticated;`,
    );
    expect(sql).not.toContain("service_role");
  });

  it("resolves keys through a roles table and refuses an unknown key", () => {
    const sql = globalRolesSql({
      ...base,
      roles: {
        table: "user_roles",
        role: { through: "roles", on: { role_id: "id" }, column: "key" },
      },
    });
    expect(sql).toContain("declare\n  v_unknown text;");
    expect(sql).toContain(`hint = 'unknown-role'`);
    expect(sql).toContain(
      `insert into "public"."user_roles" ("user_id", "role_id")\n  select p_user, k."id"\n  from "public"."roles" k`,
    );
    expect(sql).toContain(
      `and k."key"::text = any(coalesce(p_roles, '{}'::text[]))`,
    );
  });

  it("resolves keys among the global rows of a roles table that also holds tenant roles", () => {
    const sql = globalRolesSql({
      ...base,
      roles: {
        table: "user_roles",
        role: { through: "roles", on: { role_id: "id" }, column: "key" },
      },
      customRoles: {
        declared: [],
        assignable: [],
        table: { table: "roles", key: "key", tenant: "organization_id" },
      },
    });
    expect(sql).toContain(
      `where not exists (select 1 from "public"."roles" k where k."key"::text = w.r and k."organization_id" is null);`,
    );
    expect(sql).toContain(
      `and k."key"::text = any(coalesce(p_roles, '{}'::text[])) and k."organization_id" is null\n    );`,
    );
    expect(sql).toContain(
      `where k."key"::text in (select distinct r from unnest(coalesce(p_roles, '{}'::text[])) r where r is not null) and k."organization_id" is null\n`,
    );
  });

  it("leaves the lookup alone when the custom roles table is another table", () => {
    const sql = globalRolesSql({
      ...base,
      roles: {
        table: "user_roles",
        role: { through: "roles", on: { role_id: "id" }, column: "key" },
      },
      customRoles: {
        declared: [],
        assignable: [],
        table: { table: "app_roles", key: "name", tenant: "organization_id" },
      },
    });
    expect(sql).not.toContain("organization_id");
  });

  it("takes a text user id outside Supabase", () => {
    const sql = globalRolesSql({
      ...base,
      dialect: "guc",
      roles: { table: "user_roles" },
    });
    expect(sql).toContain("(p_user text, p_roles text[])");
  });
});
