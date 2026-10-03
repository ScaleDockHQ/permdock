import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { supabaseHookSql } from "../../src/cli/supabase-hook.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction, fromTable } from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const sources = [
  fromTable({ table: "memberships", columns: { expiresAt: "expires_at" } }),
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
  scopes,
  gucPrefix: "app",
  tenantType: "text",
};

function helpers(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return helpersSql(ctx, compiled.rolePermissions, { userRoles: false });
}

/** The `create function ... $$;` block of `name`, through its revoke line. */
function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  if (start === -1) {
    return "";
  }
  const end = sql.indexOf("\n\n", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

describe("member_<scope>_ids_for", () => {
  it("reads the membership sources for p_user in jwt mode", () => {
    const sql = helpers({ ...base, memberSources: sources });
    const organization = fn(sql, "member_organization_ids_for");
    expect(organization).toContain(
      "member_organization_ids_for(p_user uuid)\nreturns setof text\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''",
    );
    expect(organization).toContain('"public"."memberships"');
    expect(organization).toContain(
      'v_user_0 "public"."memberships"."user_id"%type := p_user;',
    );
    expect(organization).toContain('m."user_id" = v_user_0');
    expect(organization).toContain("coalesce(p_user::text, '') <> ''");
    expect(organization).toContain("expires_at");
    expect(organization).not.toContain("auth.uid()");
    expect(organization).not.toContain("auth.jwt()");
    expect(organization).toContain(
      'revoke execute on function "permdock".member_organization_ids_for(uuid) from public, anon, authenticated;',
    );
    expect(organization).not.toMatch(/grant execute/u);
    expect(fn(sql, "member_customer_ids_for")).toContain(
      '"public"."customer_contacts"',
    );
    expect(fn(sql, "member_organization_ids")).toContain("auth.jwt()");
  });

  it("agrees with member_<scope>_ids() in database mode except for the user", () => {
    const ctx: RlsSqlContext = {
      ...base,
      authorize: "database",
      sources,
      memberSources: sources,
    };
    const sql = helpers(ctx);
    const own = fn(sql, "member_organization_ids");
    const forUser = fn(sql, "member_organization_ids_for");
    const body = (text: string): string =>
      text.slice(text.indexOf("as $$"), text.indexOf("$$;"));
    expect(body(forUser)).toBe(
      body(own).replaceAll("(select auth.uid())", "p_user"),
    );
  });

  it("reads a mapped memberships table", () => {
    const sql = helpers({
      ...base,
      memberships: {
        scopes: {
          organization: {
            table: "org_members",
            user: "user_id",
            role: "role",
            columns: { organization: "org_id" },
            expiresAt: "expires_at",
          },
        },
      },
    });
    const organization = fn(sql, "member_organization_ids_for");
    expect(organization).toContain('from "public"."org_members" m');
    expect(organization).toContain('where m."user_id" = p_user');
    expect(organization).toContain(
      'and (m."expires_at" is null or m."expires_at" > now())',
    );
    expect(fn(sql, "member_customer_ids_for")).toBe("");
  });

  it("applies user and instance suspension to p_user", () => {
    const sql = helpers({
      ...base,
      memberSources: sources,
      suspension: {
        users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
        scopes: {
          organization: {
            table: "organizations",
            id: "id",
            status: "status",
            active: ["active"],
          },
        },
      },
    });
    const organization = fn(sql, "member_organization_ids_for");
    expect(organization).toContain(
      'exists (select 1 from "public"."profiles" s where s."id" = p_user and s."disabled_at" is null)',
    );
    expect(organization).toContain('"public"."organizations" s');
  });

  it("is not generated without a source or table, or outside Supabase", () => {
    expect(helpers(base)).not.toContain("_ids_for");
    expect(
      helpers({ ...base, dialect: "neon", memberSources: sources }),
    ).not.toContain("_ids_for");
  });
});

describe("the hook grants for member_<scope>_ids_for", () => {
  const features = { features: "better_supabase.feature_claims" };
  const config = (
    rls: PermDockConfig["rls"],
    claims: Readonly<Record<string, string>> = features,
  ): PermDockConfig => ({
    ...(rls === undefined ? {} : { rls }),
    supabase: { hook: { memberships: sources, claims } },
  });

  it("grants nothing on them without hook.claims", () => {
    const { grants, manifest } = supabaseHookSql(
      scopes,
      config(undefined, {}),
      {},
      "grants.sql",
    );
    expect(grants).not.toContain("_ids_for");
    expect(manifest.helpers.functions).toContain("member_organization_ids_for");
  });

  it("grants supabase_auth_admin execute on each generated helper", () => {
    const { grants, sql, manifest } = supabaseHookSql(
      scopes,
      config(undefined),
      {},
      "grants.sql",
    );
    expect(grants).toContain(
      'grant execute on function "permdock".member_organization_ids_for(uuid) to supabase_auth_admin;',
    );
    expect(grants).toContain(
      'grant execute on function "permdock".member_customer_ids_for(uuid) to supabase_auth_admin;',
    );
    expect(sql).not.toContain("member_organization_ids_for");
    expect(manifest.helpers.functions).toContain("member_organization_ids_for");
  });

  it("puts them in the hook file without --grants-out, with usage on the helper schema", () => {
    const { sql } = supabaseHookSql(scopes, config({ schema: "authz" }), {
      schema: "public",
    });
    expect(sql).toContain(
      'grant usage on schema "authz" to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'grant execute on function "authz".member_organization_ids_for(uuid) to supabase_auth_admin;',
    );
  });
});
