import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "text",
  authorize: "database",
  customRoles: {
    declared: ["admin", "member", "owner", "viewer"],
    assignable: ["admin", "member", "viewer"],
    permissions: ["asset.read"],
  },
};

function helpers(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return helpersSql(ctx, compiled.rolePermissions, { userRoles: true });
}

describe("custom role cascade", () => {
  it("adds the trigger only for a mapped roles table", () => {
    expect(helpers(base)).not.toContain("permdock_cascade_custom_role");
    const sql = helpers({
      ...base,
      customRoles: {
        ...(base.customRoles ?? { declared: [], assignable: [] }),
        table: {
          table: "app.roles",
          key: "name",
          tenant: "org_id",
          scope: "scope_name",
          id: "pinned_to",
          skip: "builtin",
        },
      },
    });
    expect(sql).toContain(`v_old_tenant text := old."org_id"::text;`);
    expect(sql).toContain(
      `v_old_scope text := case when old."org_id"::text is null then 'global' else old."scope_name"::text end;`,
    );
    expect(sql).toContain(`v_old_id text := old."pinned_to"::text;`);
    expect(sql).toContain(`if coalesce(old."builtin", false) then`);
    expect(sql).toContain(
      `after update or delete on "app"."roles"\n  for each row execute function "permdock".permdock_cascade_custom_role();`,
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_cascade_custom_role() from public, anon, authenticated;',
    );
  });

  it("treats a table without a tenant column as platform roles", () => {
    const sql = helpers({
      ...base,
      customRoles: {
        ...(base.customRoles ?? { declared: [], assignable: [] }),
        table: { table: "platform_roles", key: "name" },
      },
    });
    expect(sql).toContain("v_old_tenant text := null::text;");
    expect(sql).toContain(
      "v_old_scope text := case when null::text is null then 'global' else 'organization' end;",
    );
  });
});
