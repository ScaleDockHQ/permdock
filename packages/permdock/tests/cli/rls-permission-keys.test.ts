import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { permissionHelpersSql } from "../../src/cli/rls-permission-keys.ts";
import { shimGrants } from "../../src/cli/rls-shims.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  breakGlass,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions(
  {
    invoice: resource({
      id: "id",
      actions: ["read", "void"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
    }),
  },
  { renamed: { "bill.read": "invoice.read" } },
);

const policy = definePolicy(permissions, {
  roles: [
    role(
      "admin",
      [allow([permissions.invoice.read, permissions.invoice.void])],
      {
        on: "tenant",
      },
    ),
    role(
      "clerk",
      [allow(permissions.invoice.read, { where: { ownerId: principal.id } })],
      { on: "tenant" },
    ),
    role("auditor", [deny(permissions.invoice.void)], { on: "tenant" }),
    role("operator", [
      breakGlass(permissions.invoice.void, { requires: { reason: true } }),
    ]),
  ],
  scopes: { tenant: { key: "orgId" } },
  // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
  subject: (user: unknown) => user as never,
});

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "text",
};

function sql(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  const renamed = { "bill.read": "invoice.read" };
  return permissionHelpersSql(
    ctx,
    shimGrants(compiled.rolePermissions, compiled.conditionedKeys, renamed),
    renamed,
    false,
  );
}

function map(text: string): unknown {
  const match = /'(\{.*\})'::jsonb -> p_scope/u.exec(text);
  return JSON.parse(match?.[1] ?? "null");
}

describe("permission-key helpers", () => {
  it("maps a permission key to its unconditional allows and every deny, and its conditioned keys apart", () => {
    const text = sql(base);
    expect(map(text)).toEqual({
      tenant: {
        "invoice.read": {
          allow: ["invoice.read#1"],
          deny: [],
          "conditioned-allow": ["invoice.read#2"],
        },
        "invoice.void": { allow: ["invoice.void#1"], deny: ["invoice.void#2"] },
      },
    });
    expect(text).toContain(
      `coalesce('{"bill.read":"invoice.read"}'::jsonb ->> p_permission, p_permission)`,
    );
    expect(text).toContain(
      '"permdock".permitted_tenant_ids_by_permission(p_permission text)\nreturns setof text',
    );
    expect(text).toContain(
      'grant execute on function "permdock".permdock_has_permission(text) to authenticated;',
    );
    expect(text).toContain(
      '"permdock".permitted_tenant_ids_by_permission(p_permission text, p_conditioned boolean)\nreturns setof text',
    );
    expect(text).toContain(
      `select g.grant_key from "permdock".grant_keys(p_permission, 'tenant', 'conditioned-allow') g(grant_key)\n    where p_conditioned`,
    );
    expect(text).not.toContain("_for(p_user");
  });

  it("adds the forms for a named user in database mode, which no client role may run", () => {
    const text = sql({ ...base, authorize: "database" });
    expect(text).toContain(
      '"permdock".permitted_tenant_ids_by_permission_for(p_user uuid, p_permission text)',
    );
    expect(text).toContain(
      'cross join lateral "permdock".permitted_tenant_ids_for(p_user, g.grant_key) a(id)',
    );
    expect(text).toContain(
      'revoke execute on function "permdock".permdock_has_permission_for(uuid, text) from public, anon, authenticated;',
    );
  });

  it("refuses a helper name Postgres would truncate", () => {
    const long = "s".repeat(40);
    expect(() =>
      sql({ ...base, scopes: [{ name: long, key: "orgId" }] }),
    ).toThrow(/longer than 63 bytes/u);
  });
});
