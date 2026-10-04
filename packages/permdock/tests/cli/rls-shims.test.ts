import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { RlsMigrateConfig } from "../../src/cli/types.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { shimsSql } from "../../src/cli/rls-shims.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(undefined),
  gucPrefix: "app",
};

const permissions = definePermissions(
  {
    customer: resource({
      actions: ["read", "export"],
    }),
  },
  { renamed: { "organization.customers.view": "customer.read" } },
);
const roles = defineRoles({
  admin: { assignable: true },
  member: { assignable: true },
});

describe("alias rows", () => {
  it("seeds every row again under each former key, split suffix kept", () => {
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        roles: [
          role(roles.admin, [allow(permissions.customer.read)]),
          role(roles.member, [
            allow(permissions.customer.read, {
              where: { field: "ownerId", op: "eq", value: "x" },
            }),
          ]),
        ],
      },
    );
    const compiled = compileGrants(
      policy,
      { ...base, actions: { read: "none" } },
      undefined,
      [],
      false,
    );
    expect(
      compiled.rolePermissions.map(
        (row) => `${row.role} ${row.permission} ${row.grantKey}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        "admin customer.read customer.read#1",
        "admin organization.customers.view organization.customers.view#1",
      ]),
    );
  });

  it("adds an unconditional alias row the helpers answer for", () => {
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        roles: [role(roles.admin, [allow(permissions.customer.read)])],
      },
    );
    const compiled = compileGrants(policy, base, undefined, [], false);
    expect(compiled.rolePermissions).toEqual(
      expect.arrayContaining([
        {
          role: "admin",
          permission: "organization.customers.view",
          grantKey: "organization.customers.view",
          scope: "global",
          effect: "allow",
        },
      ]),
    );
  });
});

const migrate: RlsMigrateConfig = {
  helpers: {
    org_ids: { form: "ids", scope: "tenant" },
    has_org: { form: "row", scope: "tenant" },
    is_member: { form: "membership", scope: "tenant" },
    is_admin: { form: "global" },
    authorize: { form: "scoped" },
  },
  keys: { "organization.billing.view": "invoice.read" },
  prefixes: { "organization.": "", "org.": "" },
  globalScopes: ["system"],
  scopes: { organization: "tenant" },
};

describe("shimsSql", () => {
  const sql = shimsSql(base, migrate, {}, { "customer.view": "customer.read" });

  it("wraps each helper under its legacy name with invoker rights and an empty search_path", () => {
    for (const name of [
      "org_ids",
      "has_org",
      "is_member",
      "is_admin",
      "authorize",
    ]) {
      expect(sql).toContain(`create or replace function "public".${name}(`);
    }
    expect(sql.match(/security invoker/gu)).toHaveLength(5);
    expect(sql.match(/set search_path = ''/gu)).toHaveLength(5);
    expect(sql).not.toContain("security definer");
    expect(sql).not.toContain("service_role");
    expect(sql).toContain(
      `revoke execute on function "public".is_admin(text) from public, anon;`,
    );
  });

  it("maps keys exactly, then by the longest prefix", () => {
    expect(sql).toContain(
      `coalesce('{"customer.view":"customer.read","organization.billing.view":"invoice.read"}'::jsonb ->> p_key, case when pg_catalog.starts_with(p_key, 'organization.') then '' || pg_catalog.substr(p_key, 14) when pg_catalog.starts_with(p_key, 'org.') then '' || pg_catalog.substr(p_key, 5) else p_key end)`,
    );
  });

  it("routes each form to its helper", () => {
    expect(sql).toContain(`select * from "permdock".permitted_tenant_ids(`);
    expect(sql).toContain(
      `select coalesce(p_id in (select "permdock".member_tenant_ids()), false)`,
    );
    expect(sql).toContain(`select "permdock".permdock_has(`);
    expect(sql).toContain(
      `when p_scope in ('system') then "permdock".permdock_has(`,
    );
    expect(sql).toContain(
      `when p_scope = 'organization' then coalesce(p_id in (select ids::text from "permdock".permitted_tenant_ids(`,
    );
    expect(sql).toContain("else false");
  });

  it("uses p_key as is with no key map", () => {
    expect(
      shimsSql(
        base,
        { helpers: { is_admin: { form: "global" } } },
        { schema: "app" },
        {},
      ),
    ).toContain(`create or replace function "app".is_admin(p_key text)`);
    expect(
      shimsSql(base, { helpers: { is_admin: { form: "global" } } }, {}, {}),
    ).toContain(`select "permdock".permdock_has(p_key)`);
  });

  it("rejects an undeclared scope and an unsafe helper name", () => {
    expect(() =>
      shimsSql(base, { helpers: { x: { form: "ids", scope: "org" } } }, {}, {}),
    ).toThrow("rls.migrate helper scope 'org' is not a declared scope");
    expect(() =>
      shimsSql(base, { helpers: { "x; drop": { form: "global" } } }, {}, {}),
    ).toThrow("unsafe rls.migrate helper name");
  });
});
