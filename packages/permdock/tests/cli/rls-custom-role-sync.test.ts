import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { RlsCustomRolesFrom } from "../../src/cli/types.ts";

import { customRoleSyncSql } from "../../src/cli/rls/custom-role-sync.ts";
import { helpersSql } from "../../src/cli/rls/helpers.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const from: RlsCustomRolesFrom = {
  sync: "trigger",
  permissions: {
    table: "role_permissions",
    role: { through: "roles", on: { role_id: "id" }, column: "key" },
    permission: "permission",
  },
  includes: {
    table: "role_includes",
    role: { through: "roles", on: { role_id: "id" }, column: "key" },
    include: "included_role",
  },
};

const ctx: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "uuid",
  authorize: "database",
  customRoles: {
    declared: ["admin"],
    assignable: ["admin"],
    permissions: ["asset.read"],
    table: {
      table: "roles",
      key: "key",
      tenant: "organization_id",
      shared: "shared",
      skip: "builtin",
    },
  },
};

describe(customRoleSyncSql, () => {
  it("rebuilds the role through the trusted replace on every legacy write", () => {
    const sql = customRoleSyncSql(ctx, from, undefined);
    expect(sql).toContain(
      `create trigger "permdock_sync_custom_role_permissions"\n  after insert or update or delete on "public"."role_permissions"`,
    );
    expect(sql).toContain(
      `create trigger "permdock_sync_custom_role_includes"\n  after insert or update or delete on "public"."role_includes"`,
    );
    expect(sql).toContain(
      `perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);`,
    );
    expect(sql).toContain("raise warning 'permdock sync: dropped %");
    expect(sql).toContain(
      `if v.tenant_id is not null and "permdock".permdock_is_shared_role(v.scope, v.role) then`,
    );
    expect(sql).toContain("(name-taken)");
    expect(sql).toContain(
      `case when r."organization_id"::uuid is null then case when coalesce(r."shared", false) then`,
    );
  });

  it("checks a signed-in caller before the row is written, against the copy as it stood", () => {
    const sql = customRoleSyncSql(ctx, from, undefined);
    expect(sql).toContain(
      `create trigger "permdock_sync_custom_role_guard_permissions"\n  before insert or update or delete on "public"."role_permissions"`,
    );
    expect(sql).toContain(
      `create trigger "permdock_sync_custom_role_guard_includes"\n  before insert or update or delete on "public"."role_includes"`,
    );
    expect(sql).toContain(
      `if not (coalesce((select "permdock".permdock_user_id())::text, '') <> '' and pg_trigger_depth() = 1) then`,
    );
    expect(sql).toContain(
      `perform "permdock".permdock_custom_role_guard(v.tenant_id, v.scope, v.scope_id, v.role);`,
    );
    expect(sql).toContain(
      `from "permdock".permdock_custom_role_beyond(v.tenant_id, v.scope, v.scope_id, v_allow, v_deny, v_include) b;`,
    );
    expect(sql).toContain("not-assignable-by");
  });

  it("refuses a signed-in entry the guarded replace would refuse, before the hand-out check", () => {
    const sql = customRoleSyncSql(ctx, from, undefined);
    const guard = sql.slice(
      sql.indexOf("permdock_sync_custom_role_guard_permissions()"),
    );
    const refusal = guard.indexOf(
      "if cardinality(v_dropped) > 0 then\n      raise exception",
    );
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(guard.indexOf("permdock_custom_role_beyond"));
    expect(guard).toContain("then 'outside-ceiling'");
    expect(guard).toContain("then 'unknown-level'");
    expect(guard).toContain("then 'unknown-role'");
    expect(guard).toContain("else 'unknown-permission'");
  });

  it("accepts a schema-qualified through table", () => {
    const qualifiedFrom: RlsCustomRolesFrom = {
      sync: "trigger",
      permissions: {
        ...from.permissions,
        role: { through: "public.roles", on: { role_id: "id" }, column: "key" },
      },
    };
    expect(customRoleSyncSql(ctx, qualifiedFrom, undefined)).toContain(
      `create trigger "permdock_sync_custom_role_permissions"`,
    );
  });

  it("writes no includes trigger and keeps the stored includes without a mapped includes table", () => {
    const { includes: _includes, ...permissionsOnly } = from;
    const sql = customRoleSyncSql(ctx, permissionsOnly, undefined);
    expect(sql).not.toContain("permdock_sync_custom_role_includes");
    expect(sql).toContain(
      `v_include := array(select c.include_role from "permdock".custom_role_includes c where`,
    );
  });

  it("lands in the helpers only with the sync set on the context", () => {
    const custom = ctx.customRoles ?? { declared: [], assignable: [] };
    expect(helpersSql(ctx, [], { userRoles: true })).not.toContain(
      "permdock_sync_custom_role",
    );
    const synced = helpersSql(
      {
        ...ctx,
        customRoles: {
          ...custom,
          sync: customRoleSyncSql(ctx, from, undefined),
        },
      },
      [],
      { userRoles: true },
    );
    expect(synced).toContain("permdock_sync_custom_role_permissions");
  });
});
