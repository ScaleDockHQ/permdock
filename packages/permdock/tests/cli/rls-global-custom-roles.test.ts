import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { rbacScaffold } from "../../src/cli/rls-rbac.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { scopeList } from "../../src/core/scopes.ts";

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(undefined),
  gucPrefix: "app",
  customRoles: { declared: ["admin", "support"], assignable: ["support"] },
};

describe("platform custom roles in SQL", () => {
  it("stores them with no tenant at scope global and resolves them in permdock_has (database)", () => {
    const sql = helpersSql({ ...base, authorize: "database" }, [], {
      userRoles: true,
    });
    expect(sql).toContain("  tenant_id uuid,\n");
    expect(sql).toContain("check ((scope = 'global') = (tenant_id is null))");
    expect(sql).toContain("check (scope <> 'global' or scope_id is null)");
    expect(sql).toContain(
      "on \"permdock\".custom_role_permissions (coalesce(tenant_id::text, ''), scope, coalesce(scope_id, ''), role, permission, effect)",
    );
    expect(sql).toContain(
      "c.tenant_id is null and c.scope = 'global' and c.scope_id is null and c.role = ur.role::text",
    );
    expect(sql).toContain(
      "and not (ur.role::text = any(array['admin', 'support']::text[]))",
    );
    expect(sql).toMatch(/permdock_custom_keys\([\s\S]*?'global'\n {4}\)\)/u);
    expect(sql).not.toContain("where rp.scope <> 'global'");
  });

  it("reads them from the role_grants claim (jwt)", () => {
    const sql = helpersSql({ ...base, authorize: "jwt" }, [], {
      userRoles: false,
    });
    expect(sql).toContain(
      "cross join lateral (select ((select auth.jwt()) -> 'role_grants') -> r.role as g) cg",
    );
    expect(sql).not.toContain("custom_role_permissions");
  });

  it("types user_roles.role as text so a custom role name can be stored", () => {
    const permissions = definePermissions({
      tenant: resource({ collection: ["read"] }),
    });
    const policy = definePolicy(permissions, {
      subject: (user: { readonly id: string } | null) => user,
      roles: [role("support", [allow(permissions.tenant.read)])],
    });
    const scaffold = (customRoles?: { readonly declared: readonly string[] }) =>
      rbacScaffold(policy, {
        schema: "permdock",
        authorize: "database",
        ...(customRoles === undefined ? {} : { customRoles }),
      }).head;
    expect(scaffold({ declared: ["support"] })).toContain(
      "  role text not null,",
    );
    expect(scaffold()).toContain('  role "permdock"."app_role" not null,');
  });

  it("reads a stored former key as its current key", () => {
    const sql = helpersSql(
      {
        ...base,
        authorize: "database",
        customRoles: {
          declared: ["admin", "support"],
          assignable: ["support"],
          renamed: {
            "system.billing.view": "platform.billing.view",
            "billing.view": "platform.billing.view",
            "zz.view": "platform.billing.view",
          },
        },
      },
      [],
      { userRoles: true },
    );
    expect(sql).toContain(
      "with renamed (former, key) as (values ('billing.view', 'platform.billing.view'), ('system.billing.view', 'platform.billing.view'), ('zz.view', 'platform.billing.view')),",
    );
    expect(sql).toContain("left join renamed r_c on r_c.former = c.permission");
    expect(sql).toContain(
      "where not (w.permission in (select d.permission from denied d))",
    );
    expect(
      helpersSql({ ...base, authorize: "database" }, [], { userRoles: true }),
    ).not.toContain("renamed");
  });

  it("leaves permdock_has alone without custom roles", () => {
    const { customRoles: _drop, ...plain } = base;
    const sql = helpersSql({ ...plain, authorize: "database" }, [], {
      userRoles: true,
    });
    expect(sql).not.toContain("role_grants");
    expect(sql).not.toContain("permdock_custom_keys");
  });
});
