import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  customArraysQuery,
  customKeysQuery,
  customRolesSql,
} from "../../src/cli/rls/custom-roles.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: [],
  gucPrefix: "app",
  actions: { accept: "none", disable: "none", pay: "none" },
  tenantType: "uuid",
  authorize: "database",
  customRoles: {
    declared: ["admin"],
    assignable: ["admin"],
    permissions: ["asset.read"],
  },
};

const probe = {
  scope: "organization",
  role: "r.role",
  tenant: "(ms.organization_id)::uuid",
  instance: "(ms.id)::text",
};

describe("custom-role probe", () => {
  it("compares the tenant column without a cast so the unique index applies", () => {
    for (const sql of [
      customArraysQuery(ctx, probe),
      customKeysQuery(ctx, probe),
    ]) {
      expect(sql).not.toContain("tenant_id::text");
      expect(sql).not.toContain("case when pdk_s.shared");
      expect(sql).toContain(
        "(not pdk_s.shared and c.tenant_id = (ms.organization_id)::uuid or pdk_s.shared and c.tenant_id is null)",
      );
    }
  });

  it("keeps a platform role on tenant_id is null", () => {
    const sql = customArraysQuery(ctx, {
      ...probe,
      tenant: undefined,
      instance: undefined,
    });
    expect(sql).toContain("c.tenant_id is null");
  });
});

describe("custom-role tables", () => {
  it("index the probe columns and carry the entry columns in the leaf", () => {
    const sql = customRolesSql(ctx);
    expect(sql).toContain(
      'create index if not exists "custom_role_permissions_probe_idx"',
    );
    expect(sql).toMatch(
      /on [^\n]*custom_role_permissions[^\n]* \(tenant_id, scope, role\) include \(scope_id, permission, effect\);/u,
    );
    expect(sql).toMatch(
      /on [^\n]*custom_role_includes[^\n]* \(tenant_id, scope, role\) include \(scope_id, include_role\);/u,
    );
  });
});
