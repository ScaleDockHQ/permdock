import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { apiKeysPlan } from "../../src/cli/rls-api-keys.ts";
import { compileGrants } from "../../src/cli/rls-compile.ts";
import { compileConditionSql } from "../../src/cli/rls-conditions.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction, fromTable } from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const apiKeys = apiKeysPlan(true, new Set(), {});
const named = `nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '')`;
const sources = [
  fromTable({ table: "memberships" }),
  fromJunction({
    table: "customer_contacts",
    scope: "customer",
    within: { organization: "organization_id" },
    roles: ["contact"],
  }),
];
const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "text",
  ...(apiKeys === undefined ? {} : { apiKeys }),
};

function helpers(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return helpersSql(ctx, compiled.rolePermissions, { userRoles: false });
}

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

describe("rls.apiKeys tenant narrowing", () => {
  it("narrows the membership-source helpers to the key's tenant", () => {
    for (const tenants of ["all", undefined] as const) {
      const sql = helpers({
        ...base,
        authorize: "database",
        sources,
        memberSources: sources,
        ...(tenants === undefined ? {} : { tenants }),
      });
      expect(fn(sql, "permitted_organization_ids")).toContain(
        `and (${named} is null or (ms.id)::text = ${named})`,
      );
      expect(fn(sql, "permitted_customer_ids")).toContain(
        `and (${named} is null or (ms.within ->> 'organization')::text = ${named})`,
      );
      expect(fn(sql, "member_organization_ids")).toContain(
        `and (${named} is null or (ms.id)::text = ${named})`,
      );
      expect(fn(sql, "member_organization_ids_for")).not.toContain("api_key");
      expect(fn(sql, "permitted_organization_ids_for")).not.toContain(
        "api_key",
      );
    }
  });

  it("admits nothing for a key with a tenant at a scope outside the tenant chain", () => {
    const ctx: RlsSqlContext = {
      ...base,
      scopes: [...base.scopes, { name: "region", key: "region_id" }],
    };
    const sql = helpers(ctx);
    expect(fn(sql, "permitted_customer_ids")).toContain(
      `and (${named} is null or (m -> 'within' ->> 'organization')::text = ${named})`,
    );
    expect(fn(sql, "member_region_ids")).toContain(`and ${named} is null`);
    const mapped = helpers({
      ...ctx,
      authorize: "database",
      memberships: {
        scopes: {
          region: {
            table: "region_members",
            user: "user_id",
            role: "role",
            columns: { region: "region_id" },
          },
        },
      },
    });
    expect(fn(mapped, "permitted_region_ids")).toContain(
      `and ${named} is null`,
    );
    expect(fn(mapped, "member_region_ids")).toContain(`and ${named} is null`);
  });

  it("narrows memberOf membership checks to the key's tenant", () => {
    const ctx: RlsSqlContext = {
      ...base,
      memberships: {
        scopes: {
          organization: {
            table: "org_members",
            user: "user_id",
            role: "role",
            columns: { organization: "org_id" },
          },
          customer: {
            table: "customer_members",
            user: "user_id",
            role: "role",
            columns: { customer: "customer_id", organization: "org_id" },
          },
        },
      },
    };
    const memberOf = (scope: string): string =>
      compileConditionSql(
        { op: "memberOf", scope, field: `${scope}_id`, roles: [] },
        ctx,
      );
    expect(memberOf("organization")).toContain(
      `(${named} is null or (m."org_id")::text = ${named})`,
    );
    expect(memberOf("customer")).toContain(
      `(${named} is null or (m."org_id")::text = ${named})`,
    );
    const unmapped = compileConditionSql(
      {
        op: "memberOf",
        scope: "organization",
        field: "organization_id",
        roles: [],
      },
      { ...base },
    );
    expect(unmapped).toContain(
      `(${named} is null or ("organization_id")::text = ${named})`,
    );
    const all = compileConditionSql(
      {
        op: "memberOf",
        scope: "organization",
        field: "organization_id",
        roles: [],
      },
      { ...base, tenants: "all" },
    );
    expect(all).toContain("member_organization_ids()");
    expect(all).not.toContain("api_key");
  });
});
