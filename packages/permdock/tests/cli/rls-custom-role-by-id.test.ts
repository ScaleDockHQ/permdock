import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { customRoleByIdSql } from "../../src/cli/rls/custom-role-by-id.ts";

const roles = {
  table: "app_roles",
  key: "name",
  tenant: "organization_id",
  skip: "is_system",
  primaryKey: "id",
};

function ctx(
  custom: Partial<NonNullable<RlsSqlContext["customRoles"]>> = {},
  extra: Partial<RlsSqlContext> = {},
): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: [{ name: "org", key: "org_id" }],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    customRoles: {
      declared: ["owner"],
      assignable: ["owner"],
      permissions: ["doc.read", "doc.update"],
      renamed: { "file.read": "doc.read" },
      table: roles,
      audit: {
        function: "better_supabase.audit_event_trusted",
        args: { actor_kind: "user" },
      },
      ...custom,
    },
    ...extra,
  };
}

describe("custom-role functions keyed by role id", () => {
  it("writes the by-id writers, the trusted variant and the trusted reader", async () => {
    const sql = customRoleByIdSql(ctx(), ["service_role"]);
    await expect(sql).toMatchFileSnapshot(
      "./fixtures/golden/custom-role-by-id.sql",
    );
  });

  it("takes the id type from the roles table and grants the reader only to trustedReaders", () => {
    const sql = customRoleByIdSql(ctx(), ["service_role"]);
    expect(sql).toContain(
      'permdock_replace_custom_role_grants_by_id(p_role_id "public"."app_roles"."id"%type, p_permissions text[])',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_replace_custom_role_grants_by_id("public"."app_roles"."id"%type, text[]) to authenticated;',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_trusted_replace_custom_role_grants_by_id("public"."app_roles"."id"%type, text[]) from public, anon, authenticated;',
    );
    expect(
      sql.match(/^grant execute .*$/gmu)?.map((line) => line.split(" to ")[1]),
    ).toEqual(["authenticated;", '"service_role";']);
    expect(sql).toContain(
      'grant usage on schema "permdock" to "service_role";',
    );
    expect(customRoleByIdSql(ctx(), undefined)).not.toMatch(/service_role/u);
  });

  it("calls the audit function with the role's tenant and the extra arguments", () => {
    const sql = customRoleByIdSql(ctx(), undefined);
    expect(sql).toContain(
      `perform "better_supabase"."audit_event_trusted"(event_type => 'permdock.custom_role.replaced', target_type => 'role', record_id => p_role_id::text, tenant => v_tenant, metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions), "actor_kind" => 'user');`,
    );
    const base = ctx();
    const { audit: _audit, ...unaudited } = base.customRoles ?? {
      declared: [],
      assignable: [],
    };
    expect(
      customRoleByIdSql({ ...base, customRoles: unaudited }, undefined),
    ).not.toContain('perform "better_supabase"');
  });

  it("returns levelled entries and current keys from the reader", () => {
    const sql = customRoleByIdSql(ctx({ levels: true }), undefined);
    expect(sql).toContain(
      "(case c.permission when 'file.read' then 'doc.read' else c.permission end) || coalesce('@' || c.level, '')",
    );
  });

  it("writes nothing without a primary key, custom roles or database mode", () => {
    const { primaryKey: _primaryKey, ...keyless } = roles;
    expect(customRoleByIdSql(ctx({ table: keyless }), [])).toBe("");
    expect(customRoleByIdSql(ctx({}, { authorize: "jwt" }), [])).toBe("");
    const { customRoles: _customRoles, ...plain } = ctx();
    expect(customRoleByIdSql(plain, [])).toBe("");
  });
});
