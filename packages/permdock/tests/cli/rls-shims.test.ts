import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { RlsMigrateConfig } from "../../src/cli/types.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { shimGrants, shimMap, shimsSql } from "../../src/cli/rls-shims.ts";
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

const grants = new Map([
  [
    "tenant",
    { "invoice.read": { allow: ["invoice.read#1"], deny: ["invoice.read#3"] } },
  ],
  ["global", { "invoice.read": { allow: ["invoice.read"], deny: [] } }],
]);

describe("shimGrants", () => {
  it("keeps unconditional allows and every deny, per scope, without former keys, and lists the conditioned keys apart", () => {
    expect(
      Object.fromEntries(
        shimGrants(
          [
            {
              role: "staff",
              permission: "quote.read",
              grantKey: "quote.read#1",
              scope: "tenant",
              effect: "allow",
            },
            {
              role: "contact",
              permission: "quote.read",
              grantKey: "quote.read#2",
              scope: "customer",
              effect: "allow",
            },
            {
              role: "guest",
              permission: "quote.read",
              grantKey: "quote.read#3",
              scope: "tenant",
              effect: "deny",
            },
            {
              role: "admin",
              permission: "quote.read",
              grantKey: "quote.read#1",
              scope: "tenant",
              effect: "allow",
            },
            {
              role: "staff",
              permission: "quotes.view",
              grantKey: "quotes.view#1",
              scope: "tenant",
              effect: "allow",
            },
            {
              role: "owner",
              permission: "quote.read",
              grantKey: "quote.read#4",
              scope: "tenant",
              effect: "allow",
            },
          ],
          new Set(["quote.read#2", "quote.read#3", "quote.read#4"]),
          { "quotes.view": "quote.read" },
        ),
      ),
    ).toEqual({
      customer: {
        "quote.read": {
          allow: [],
          deny: [],
          "conditioned-allow": ["quote.read#2"],
        },
      },
      tenant: {
        "quote.read": {
          allow: ["quote.read#1"],
          deny: ["quote.read#3"],
          "conditioned-allow": ["quote.read#4"],
          "conditioned-deny": ["quote.read#3"],
        },
      },
    });
  });
});

describe("shimMap", () => {
  it("keeps only what a shim reads: the allow and deny lists of permissions that have one", () => {
    const lists = shimGrants(
      [
        {
          role: "contact",
          permission: "quote.read",
          grantKey: "quote.read#2",
          scope: "tenant",
          effect: "allow",
        },
        {
          role: "staff",
          permission: "asset.read",
          grantKey: "asset.read",
          scope: "tenant",
          effect: "allow",
        },
      ],
      new Set(["quote.read#2"]),
      {},
    );
    expect(JSON.parse(shimMap(lists, "tenant"))).toEqual({
      "asset.read": { allow: ["asset.read"], deny: [] },
    });
    expect(shimMap(lists, "customer")).toBe("{}");
  });
});

describe("shimsSql", () => {
  const sql = shimsSql(
    base,
    migrate,
    {},
    { "customer.view": "customer.read" },
    grants,
  );

  it("wraps each helper under its legacy name as security definer with an empty search_path", () => {
    for (const name of [
      "org_ids",
      "has_org",
      "is_member",
      "is_admin",
      "authorize",
    ]) {
      expect(sql).toContain(`create or replace function "public".${name}(`);
    }
    expect(sql.match(/security definer/gu)).toHaveLength(5);
    expect(sql.match(/set search_path = ''/gu)).toHaveLength(5);
    expect(sql).not.toContain("security invoker");
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

  it("answers from the grant keys of the helper's scope, minus the denies", () => {
    const tenant = `'{"invoice.read":{"allow":["invoice.read#1"],"deny":["invoice.read#3"]}}'::jsonb`;
    expect(sql).toContain(
      `from pg_catalog.jsonb_array_elements_text(coalesce(${tenant} -> (`,
    );
    expect(sql).toContain(`) -> 'allow', '[]'::jsonb)) g(grant_key)
  cross join lateral "permdock".permitted_tenant_ids(g.grant_key) a(id)
  except
  select d.id`);
    expect(sql).toContain(
      `select coalesce(p_id in (select "permdock".member_tenant_ids()), false)`,
    );
    expect(sql).toContain(
      `where "permdock".permdock_has(g.grant_key))\n    and not exists (`,
    );
    expect(sql).toContain(
      `'{"invoice.read":{"allow":["invoice.read"],"deny":[]}}'::jsonb`,
    );
    expect(sql).toContain(`when p_scope in ('system') then exists (`);
    expect(sql).toContain(
      `when p_scope = 'organization' then coalesce(p_id in (select s.id::text from (`,
    );
    expect(sql).toContain("else false");
  });

  it("uses p_key as is with no key map, and an empty map for an ungranted scope", () => {
    expect(
      shimsSql(
        base,
        { helpers: { is_admin: { form: "global" } } },
        { schema: "app" },
        {},
        new Map(),
      ),
    ).toContain(`create or replace function "app".is_admin(p_key text)`);
    const plain = shimsSql(
      base,
      { helpers: { is_admin: { form: "global" } } },
      {},
      {},
      new Map(),
    );
    expect(plain).toContain(
      `coalesce('{}'::jsonb -> (p_key) -> 'allow', '[]'::jsonb)`,
    );
  });

  it("answers a scoped helper from the declared scope names alone", () => {
    const scoped = shimsSql(
      base,
      { helpers: { b: { form: "scoped" }, a: { form: "global" } } },
      {},
      {},
      grants,
    );
    expect(scoped).not.toContain("when p_scope in (");
    expect(scoped).toContain(
      `when p_scope = 'tenant' then coalesce(p_id in (select s.id::text from (`,
    );
    expect(scoped.indexOf('"public".a(')).toBeLessThan(
      scoped.indexOf('"public".b('),
    );
  });

  it("rejects an undeclared scope and an unsafe helper name", () => {
    expect(() =>
      shimsSql(
        base,
        { helpers: { x: { form: "ids", scope: "org" } } },
        {},
        {},
        grants,
      ),
    ).toThrow("rls.migrate helper scope 'org' is not a declared scope");
    expect(() =>
      shimsSql(
        base,
        { helpers: { "x; drop": { form: "global" } } },
        {},
        {},
        grants,
      ),
    ).toThrow("unsafe rls.migrate helper name");
  });
});
