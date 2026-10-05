import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction } from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  tenantType: "text",
};
const memberships = {
  scopes: {
    organization: {
      table: "org_members",
      user: "user_id",
      role: "role",
      columns: { organization: "org_id" },
    },
  },
};

function helpers(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return helpersSql(ctx, compiled.rolePermissions, { userRoles: true });
}

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  if (start === -1) {
    return "";
  }
  const end = sql.indexOf("\n\n", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

function body(text: string): string {
  return text.slice(text.indexOf("as $$"), text.indexOf("$$;"));
}

describe("helpers for a named user", () => {
  it("emits permdock_has_for and permitted_<scope>_ids_for in database mode", () => {
    const sql = helpers({ ...base, authorize: "database", memberships });
    const has = fn(sql, "permdock_has_for");
    expect(has).toContain(
      "permdock_has_for(p_user uuid, p_grant text)\nreturns boolean",
    );
    expect(has).toContain(
      'revoke execute on function "permdock".permdock_has_for(uuid, text) from public, anon, authenticated;',
    );
    expect(has).not.toMatch(/grant execute/u);
    expect(body(has)).toBe(
      body(fn(sql, "permdock_has")).replaceAll("(select auth.uid())", "p_user"),
    );
    const ids = fn(sql, "permitted_organization_ids_for");
    expect(ids).toContain(
      "permitted_organization_ids_for(p_user uuid, p_grant text)\nreturns setof text",
    );
    expect(ids).toContain('where m."user_id" = p_user');
    expect(ids).not.toContain("auth.uid()");
    expect(ids).not.toContain("auth.jwt()");
    expect(fn(sql, "permitted_organization_ids")).toContain("tenant_id");
  });

  it("reads the membership sources for p_user", () => {
    const source = fromJunction({
      table: "customer_contacts",
      scope: "customer",
      within: { organization: "organization_id" },
      roles: ["contact"],
    });
    const sql = helpers({
      ...base,
      authorize: "database",
      memberships,
      sources: [source],
    });
    const ids = fn(sql, "permitted_customer_ids_for");
    expect(ids).toContain(
      'v_user_0 "public"."customer_contacts"."user_id"%type := p_user;',
    );
    expect(ids).toContain("coalesce(p_user::text, '') <> ''");
    expect(ids).not.toContain("auth.");
  });

  it("takes a text user outside Supabase", () => {
    const sql = helpers({
      ...base,
      dialect: "guc",
      authorize: "database",
      memberships,
    });
    expect(sql).toContain(
      '"permdock".permdock_has_for(p_user text, p_grant text)',
    );
  });

  it("emits none in jwt mode, where the rights live in the token", () => {
    const sql = helpers({ ...base, memberships });
    expect(sql).not.toContain("_for(p_user uuid, p_grant text)");
  });
});
