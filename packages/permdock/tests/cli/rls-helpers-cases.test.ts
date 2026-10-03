import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import {
  accessSql,
  helpersSql,
  membershipTable,
} from "../../src/cli/rls-helpers.ts";
import { fromTable } from "../../src/supabase/index.ts";

const scopes = [
  { name: "org", key: "org_id" },
  { name: "team", key: "team_id", within: "org" },
  { name: "region", key: "region_id" },
];

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    ...extra,
  };
}

const helpers = (extra: Partial<RlsSqlContext>, userRoles = false) =>
  helpersSql(ctx(extra), [], { userRoles });

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

const teamMembers = {
  table: "app.team_members",
  user: "user_id",
  role: "role",
  columns: { team: "team_id", org: "org_id" },
};

describe("accessSql and membershipTable", () => {
  it("needs the scope column for a scoped grant", () => {
    expect(() => accessSql(ctx(), "team", "doc.read", undefined)).toThrow(
      "team-scoped grant needs definePolicy({ scopes.team })",
    );
  });

  it("keeps a schema-qualified membership table", () => {
    expect(membershipTable("app.members")).toBe('"app"."members"');
    expect(membershipTable("members")).toBe('"public"."members"');
  });
});

describe("helpersSql schema", () => {
  it("creates the private permdock schema and grants only usage", () => {
    const sql = helpers({});
    expect(sql).toContain(
      'create schema if not exists "permdock";\nrevoke all on schema "permdock" from public;\ngrant usage on schema "permdock" to authenticated;',
    );
    expect(
      helpersSql(ctx(), [], { userRoles: false, anonExecute: true }),
    ).toContain('grant usage on schema "permdock" to anon, authenticated;');
  });

  it("leaves public alone when it is configured", () => {
    expect(helpers({ schema: "public" })).not.toContain("create schema");
  });
});

describe("helpersSql scopes off the root chain", () => {
  it("does not narrow a scope outside the first scope to the active tenant (jwt)", () => {
    const sql = helpers({});
    expect(fnBody(sql, "permitted_team_ids")).toContain("->> 'tenant_id'");
    expect(fnBody(sql, "permitted_region_ids")).not.toContain(
      "->> 'tenant_id'",
    );
  });

  it("does not narrow a sourced scope outside the first scope (database)", () => {
    const sql = helpers({
      authorize: "database",
      sources: [fromTable({ table: "memberships" })],
    });
    expect(fnBody(sql, "permitted_region_ids")).not.toContain("is null or");
  });

  it("refuses custom roles over membership sources", () => {
    expect(() =>
      helpers({
        authorize: "database",
        sources: [fromTable({ table: "memberships" })],
        customRoles: { declared: [], assignable: [] },
      }),
    ).toThrow(
      "--custom-roles in database mode needs rls.memberships.scopes.org",
    );
  });
});

describe("helpersSql database mode", () => {
  it("matches custom roles on the scope column when the table holds no tenant column", () => {
    const sql = helpers({
      authorize: "database",
      memberships: {
        scopes: {
          org: {
            table: "org_members",
            user: "user_id",
            role: "role",
            columns: { org: "org_id" },
          },
        },
      },
      customRoles: { declared: [], assignable: [] },
    });
    expect(sql).toContain('c.tenant_id::text = m."org_id"::text');
    expect(sql).toContain(`'{}'::text[]`);
  });

  it("types user_roles.user_id as text outside Supabase", () => {
    expect(helpers({ authorize: "database", dialect: "guc" }, true)).toContain(
      "  user_id text not null,",
    );
    expect(helpers({ authorize: "database" }, true)).toContain(
      "  user_id uuid not null references auth.users on delete cascade,",
    );
  });

  it("needs the ancestor column to check a suspended ancestor", () => {
    expect(() =>
      helpers({
        authorize: "database",
        memberships: {
          scopes: { team: { ...teamMembers, columns: { team: "team_id" } } },
        },
        suspension: {
          scopes: {
            org: { table: "orgs", id: "id", disabledAt: "disabled_at" },
          },
        },
      }),
    ).toThrow("rls.suspension.scopes.org needs the org id on team memberships");
  });

  it("checks a suspended ancestor through its column", () => {
    const sql = helpers({
      authorize: "database",
      memberships: { scopes: { team: teamMembers } },
      suspension: {
        scopes: { org: { table: "orgs", id: "id", disabledAt: "disabled_at" } },
      },
    });
    expect(fnBody(sql, "member_team_ids")).toContain(
      's."id" = (m."org_id")::uuid',
    );
  });
});
