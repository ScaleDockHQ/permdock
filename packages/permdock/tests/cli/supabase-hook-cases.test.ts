import { describe, expect, it } from "vitest";

import type { SqlMembershipSource } from "../../src/supabase/sources.ts";

import { activeFromSql } from "../../src/cli/supabase-hook/memberships.ts";
import {
  loadScopes,
  runSupabase,
  supabaseHookSql,
} from "../../src/cli/supabase-hook/supabase-hook.ts";
import { fromJunction, fromTable } from "../../src/supabase/index.ts";

const scopes = [
  { name: "organization", key: "organization_id" },
  { name: "customer", key: "customer_id", within: "organization" },
];

const io = { stdout: () => undefined, stderr: () => undefined };

const hookWith = (memberships: readonly SqlMembershipSource[]) => () =>
  supabaseHookSql(scopes, {
    policy: "p.ts",
    supabase: { hook: { memberships } },
  });

describe("activeFromSql", () => {
  it("reads app_metadata, a table column or a mapped id column", () => {
    expect(activeFromSql(undefined, "organization")).toEqual({
      sql: `claims -> 'app_metadata' ->> 'active_organization'`,
    });
    expect(activeFromSql("app.profiles.active_org", "organization")).toEqual({
      sql: `(select a."active_org"::text from "app"."profiles" a where a."id" = v_active_user)`,
      userType: `"app"."profiles"."id"%type`,
    });
    expect(
      activeFromSql(
        { table: "profiles", column: "org", id: "user_id" },
        "organization",
      ),
    ).toEqual({
      sql: `(select a."org"::text from "public"."profiles" a where a."user_id" = v_active_user)`,
      userType: `"public"."profiles"."user_id"%type`,
    });
  });

  it.each([
    ["app_metadata.bad-key", "unsafe app_metadata key 'bad-key'"],
    [
      "profiles",
      "--active-from must be app_metadata.<key> or <table>.<column>, got 'profiles'",
    ],
    [
      ".org",
      "--active-from must be app_metadata.<key> or <table>.<column>, got '.org'",
    ],
  ])("refuses %s", (spec, message) => {
    expect(() => activeFromSql(spec, "organization")).toThrow(message);
  });
});

describe("supabase.hook.memberships sources", () => {
  it("needs at least one source", () => {
    expect(hookWith([])).toThrow(
      "supabase.hook.memberships needs at least one fromTable or fromJunction source",
    );
  });

  it("takes only fromTable and fromJunction sources", () => {
    // SAFETY: a config written without the permdock/supabase helpers, which the check refuses.
    const plain = { table: "memberships" } as unknown as SqlMembershipSource;
    expect(hookWith([plain])).toThrow(
      "takes fromTable / fromJunction sources from permdock/supabase",
    );
  });

  it("needs the declared scope name and every ancestor column", () => {
    const aliased = fromJunction({
      table: "contacts",
      scope: "team",
      within: { organization: "organization_id" },
      roles: ["contact"],
    });
    expect(hookWith([fromTable({ table: "memberships" }), aliased])).toThrow(
      "the contacts source names scope 'team', which the policy does not declare by that name",
    );
    const orphan = fromJunction({
      table: "contacts",
      scope: "customer",
      roles: ["contact"],
    });
    expect(hookWith([orphan])).toThrow(
      "the contacts source needs within columns for organization: a customer membership without every ancestor grants nothing",
    );
  });
});

describe("runSupabase dispatch", () => {
  it("prints help for an unknown area and needs a policy", async () => {
    const help = await runSupabase({
      cwd: ".",
      config: {},
      rest: ["hook", "drop"],
      check: false,
      io,
    });
    expect(help.code).toBe(2);
    await expect(loadScopes(".", {})).rejects.toThrow(
      "supabase hook generate needs policy in permdock.config.ts",
    );
  });
});

describe("supabase.hook.api", () => {
  const hook = (api?: { schema?: string; prefix?: string }) =>
    supabaseHookSql(scopes, {
      policy: "p.ts",
      supabase: {
        hook: {
          memberships: [fromTable({ table: "memberships" })],
          ...(api === undefined ? {} : { api }),
        },
      },
    }).sql;

  it("writes no wrapper without the option and never grants service_role", () => {
    const sql = hook();
    expect(sql).not.toContain("permdock_subject_for");
    expect(sql).not.toContain("service_role");
  });

  it("writes the three wrappers in public with the default prefix", () => {
    const sql = hook({});
    expect(sql).toContain(
      `create or replace function "public"."permdock_subject_for"(p_user uuid)\nreturns jsonb`,
    );
    expect(sql).toContain(
      `as $$ select "permdock".subject_for(p_user) $$;\nrevoke execute on function "public"."permdock_subject_for"(uuid) from public, anon, authenticated;\ngrant execute on function "public"."permdock_subject_for"(uuid) to service_role;`,
    );
    expect(sql).toContain(
      `create or replace function "public"."permdock_members_of"(p_scope text, p_id text)`,
    );
    expect(sql).toContain(`select "permdock".members_of(p_scope, p_id)`);
    expect(sql).toContain(
      `create or replace function "public"."permdock_authz_version_for"(p_user uuid)\nreturns bigint`,
    );
  });

  it("honours the schema and the prefix", () => {
    const sql = hook({ schema: "api", prefix: "pd_" });
    expect(sql).toContain(`"api"."pd_subject_for"`);
    expect(sql).toContain(`"api"."pd_members_of"`);
    expect(sql).toContain(`"api"."pd_authz_version_for"`);
  });

  it("refuses a wrapper that would replace the function it wraps", () => {
    expect(() => hook({ schema: "permdock", prefix: "" })).toThrow(
      /would replace "permdock"\.subject_for/,
    );
  });
});
