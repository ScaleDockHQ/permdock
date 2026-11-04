import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  memoReadTriggersSql,
  readTables,
} from "../../src/cli/rls/memo-generation.ts";
import { memoRowSql, memoRowTriggersSql } from "../../src/cli/rls/row-memo.ts";
import { rowHelpersSql } from "../../src/cli/rls/rows.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "doc_shares", object: "doc_id", subject: "user_id" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [role("member", [allow(permissions.doc.read)], { on: "tenant" })],
  grants: [
    allow(permissions.doc.read, { to: relation(permissions.doc, "viewer") }),
  ],
  subject: () => null,
});

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: scopeList(policy.scopes),
  tenantClaim: "tenant_id",
  gucPrefix: "app",
  authorize: "database",
  memberships: {
    scopes: {
      tenant: {
        table: "org_members",
        user: "user_id",
        role: "role",
        columns: { tenant: "org_id" },
      },
    },
  },
};

const arm = (key: string, sql: string) => ({
  key,
  sql: `    when '${key}' then ${sql}`,
});

function memo(...arms: ReturnType<typeof arm>[]): string | undefined {
  return memoRowSql(
    ctx,
    policy,
    '"permdock".permitted_doc_row',
    'p_row "public"."doc"',
    "doc",
    arms,
    "permdock_candidates as (select (p_row).*)",
  );
}

describe(memoRowSql, () => {
  it("returns nothing when no arm calls a helper it can hold", () => {
    expect(
      memo(
        arm("a", `"locked" = false`),
        arm("b", `exists (select "permdock".permdock_has('a'))`),
        arm("c", `(select "other".permdock_has('a'))`),
        arm("d", `(select "permdock".unknown_helper('a'))`),
        arm("e", `(select 1 from "public"."doc")`),
        arm("f", `(select permdock_has('a'))`),
        arm("g", `(select "permdock" .permdock_has('a'))`),
        arm("h", `(select "permdock".permdock_has)`),
        arm("i", `(select "permdock".permdock_has('a' 'b'))`),
        arm("j", `(select "permdock".permdock_has(p_permission))`),
        arm("k", `(select "permdock".permdock_has('a') where true)`),
        arm("l", `'(select "permdock".permdock_has(''a''))'`),
        arm("m", `"(select ""permdock"".permdock_has('a'))"`),
        arm("n", `(select "permdock".permdock_has('unterminated`),
      ),
    ).toBeUndefined();
    expect(
      memoRowSql(
        { ...ctx, authorize: "jwt" },
        policy,
        "f",
        "t",
        "doc",
        [arm("a", `(select "permdock".permdock_has('a'))`)],
        "c",
      ),
    ).toBeUndefined();
  });

  it("reads constant arguments, casts, nested arrays and quoted names", () => {
    const sql =
      memo(
        arm(
          "a",
          `(select "permdock".permdock_has('it''s'::text)) and "id"::text in (select "permdock".permitted_tenant_ids_by_permission('a', false)) and "x" = any (array(select "permdock".member_tenant_ids( ))) and (select "permdock".permitted_doc_ids(null)) is not null and (select "permdock".permdock_api_key_allows(1.5))`,
        ),
        arm("b", `(select "permdock".permdock_has('it''s'::text)) or "locked"`),
        arm("c", `"locked"`),
      ) ?? "";
    expect(sql).toContain(
      `when 'a' then jsonb_build_object('t0', to_jsonb((select "permdock".permdock_has('it''s'::text))), 't1', to_jsonb(array(select "permdock".permitted_tenant_ids_by_permission('a', false))), 't2', to_jsonb(array(select "permdock".member_tenant_ids( ))), 't3', to_jsonb((select "permdock".permitted_doc_ids(null))), 't4', to_jsonb((select "permdock".permdock_api_key_allows(1.5))))`,
    );
    expect(sql).toContain(
      `when 'b' then jsonb_build_object('t0', to_jsonb((select "permdock".permdock_has('it''s'::text))))`,
    );
    expect(sql).not.toContain("when 'c' then jsonb_build_object");
    expect(sql).toContain(
      `"x" = any (array(select pdm.v::uuid from pg_catalog.jsonb_array_elements_text(v_permdock_terms -> 't2') pdm(v)))`,
    );
    expect(sql).toContain(`((v_permdock_terms ->> 't3')::text) is not null`);
    expect(sql).toContain("    when 'c' then \"locked\"");
  });

  it("splits a long arm into objects of fifty pairs", () => {
    const calls = Array.from(
      { length: 51 },
      (_, index) => `(select "permdock".permdock_has('k${String(index)}'))`,
    ).join(" or ");
    const sql = memo(arm("a", calls)) ?? "";
    expect(sql).toContain(
      `'t49', to_jsonb((select "permdock".permdock_has('k49')))) || jsonb_build_object('t50', to_jsonb((select "permdock".permdock_has('k50'))))`,
    );
  });
});

describe("row memo triggers", () => {
  it("reads the qualified tables a body selects from, not functions or auth", () => {
    expect(
      readTables(
        `select 1 from "public"."a" x join public.b on true join "auth"."users" u on true join "permdock".f(1) on true cross join lateral "permdock".g ( ) where x in (select y from "we""ird".t)`,
      ),
    ).toStrictEqual(["public.a", "public.b", 'we"ird.t']);
  });

  it("skips alias columns after is distinct from and extract from", () => {
    expect(
      readTables(
        `select 1 from public.members m where m.tenant_id is not distinct from m.scope_id and extract(epoch from m.expires_at) > 0 and c.a is distinct from v.b`,
      ),
    ).toStrictEqual(["public.members"]);
  });

  it("bumps on relation tables the scope memo does not cover", () => {
    const sql = memoRowTriggersSql(ctx, policy, undefined);
    expect(sql).toContain(
      'create trigger "permdock_memo_generation"\n  after insert or update or delete on "public"."doc_shares"',
    );
    expect(sql).not.toContain('on "public"."org_members"');
    expect(
      memoReadTriggersSql(ctx, `select 1 from permdock.role_permissions`, ""),
    ).toBe("");
    expect(
      memoRowTriggersSql({ ...ctx, authorize: "jwt" }, policy, undefined),
    ).toBe("");
  });

  it("writes no triggers without a row helper", () => {
    expect(rowHelpersSql(ctx, policy, [], [], undefined, [])).toBe("");
  });
});
