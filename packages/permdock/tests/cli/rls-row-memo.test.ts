import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  memoReadTriggersSql,
  readTables,
} from "../../src/cli/rls/memo-generation.ts";
import { memoRowTriggersSql } from "../../src/cli/rls/row-memo.ts";
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
