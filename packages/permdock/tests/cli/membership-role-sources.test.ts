import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type {
  PermDockConfig,
  RlsMembershipTable,
} from "../../src/cli/types.ts";

import { decidingColumns } from "../../src/cli/deciding-columns.ts";
import { compileGrants } from "../../src/cli/rls-compile.ts";
import { compileConditionSql } from "../../src/cli/rls-conditions.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import {
  supabaseHookManifest,
  supabaseHookSql,
} from "../../src/cli/supabase-hook.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction, fromTable } from "../../src/supabase/index.ts";
import { roleColumn } from "../../src/supabase/roles.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);
const through = { through: "roles", on: { role_id: "id" }, column: "key" };
const sources = ["tier", through] as const;
const lateral =
  'cross join lateral (select "mv".role from (values (m."tier"::text), ((select mk."key"::text from "public"."roles" mk where mk."id" = m."role_id"))) "mv"(role) where "mv".role is not null) "mr"(permdock_role)';

const organizationUsers = fromJunction({
  table: "organization_users",
  scope: "organization",
  roles: { sources },
});

const table: RlsMembershipTable = {
  table: "organization_users",
  user: "user_id",
  role: sources,
  columns: { organization: "organization_id" },
};

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  tenantType: "uuid",
  ...(ownership === undefined ? {} : { ownership }),
};

/** The `create function ... $$;` block of `name`. */
function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

describe("role sources", () => {
  it("resolves one source as that source and refuses an empty list", () => {
    const one = roleColumn(["tier"], "public.t", "m", { label: "role" });
    expect(one).toMatchObject({ sql: 'm."tier"::text', lateral: false });
    expect(() => roleColumn([], "public.t", "m", { label: "role" })).toThrow(
      "PermDock: role needs at least one role source",
    );
    expect(() =>
      roleColumn(
        ["tier", { through: "roles", on: {}, column: "key" }],
        "public.t",
        "m",
        { label: "role" },
      ),
    ).toThrow("role[1].on must map exactly one column");
  });

  it("expands a row into one row per non-null key in the source", () => {
    const sql = organizationUsers.sql.select("$1");
    expect(sql).toContain(`from "public"."organization_users" m\n${lateral}`);
    expect(sql).toContain(
      'jsonb_agg(distinct "mr".permdock_role order by "mr".permdock_role)',
    );
    expect(organizationUsers.sql.throughs).toEqual([
      { table: "public.roles", id: "id", key: "key", ref: "role_id" },
    ]);
    expect(organizationUsers.sql.manifest.role).toEqual([
      { column: "tier" },
      {
        column: "role_id",
        through: { table: "public.roles", id: "id", column: "key" },
      },
    ]);
    const shared = fromTable({
      table: "memberships",
      columns: { role: sources },
    });
    expect(shared.sql.columns).toEqual([
      "user_id",
      "scope",
      "scope_id",
      "tier",
      "role_id",
    ]);
  });

  it("bumps holders of a renamed key and counts every source column as deciding", () => {
    const config: PermDockConfig = {
      policy: "p.ts",
      supabase: { hook: { memberships: [organizationUsers] } },
    };
    const { sql } = supabaseHookSql(scopes, config);
    expect(sql).toContain(
      'select h."user_id"::uuid as user_id from "public"."organization_users" h where h."role_id" = old."id"',
    );
    expect(sql).toContain(
      'grant select on table "public"."roles" to supabase_auth_admin;',
    );
    expect(decidingColumns(config)).toEqual([
      "public.organization_users.organization_id",
      "public.organization_users.role_id",
      "public.organization_users.tier",
      "public.organization_users.user_id",
      "public.roles.id",
      "public.roles.key",
    ]);
  });

  it("maps an rls.memberships table with several sources into the hook manifest", () => {
    const manifest = supabaseHookManifest(scopes, {
      policy: "p.ts",
      rls: { memberships: { scopes: { organization: table } } },
      supabase: { hook: { memberships: [organizationUsers] } },
    });
    const entry = manifest.rls.memberships.find(
      (item) => item.table === "public.organization_users",
    );
    expect(entry?.role).toEqual([
      { column: "tier" },
      {
        column: "role_id",
        through: { table: "public.roles", id: "id", column: "key" },
      },
    ]);
    expect(entry?.columns).toEqual(expect.arrayContaining(["tier", "role_id"]));
  });

  it("expands the row in the database-mode helpers and the memberOf condition", () => {
    const ctx: RlsSqlContext = {
      ...base,
      authorize: "database",
      memberships: { scopes: { organization: table } },
    };
    const compiled = compileGrants(policy, ctx, undefined, [], false);
    const sql = helpersSql(ctx, compiled.rolePermissions, { userRoles: false });
    const permitted = fn(sql, "permitted_organization_ids");
    expect(permitted).toContain("select distinct");
    expect(permitted).toContain(lateral);
    expect(permitted).toContain('rp.role = "mr".permdock_role');
    expect(fn(sql, "member_organization_ids")).toContain(
      '"mr".permdock_role is not null',
    );
    const condition = compileConditionSql(
      {
        op: "memberOf",
        scope: "organization",
        field: "organization_id",
        roles: ["admin"],
      },
      ctx,
    );
    expect(condition).toContain(`m ${lateral} where`);
    expect(condition).toContain(`"mr".permdock_role = any('{admin}')`);
  });

  it("counts holders across every source in the ownership triggers", () => {
    const sql = ownershipSql({
      ...base,
      authorize: "database",
      memberships: { scopes: { organization: table } },
    });
    expect(sql).toContain(lateral);
    expect(sql).toContain(`select count(distinct m."user_id") into v_count
      from "public"."organization_users" m
      ${lateral}
      where m."organization_id" = v_key
        and "mr".permdock_role = 'owner'`);
  });
});
