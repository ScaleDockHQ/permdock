import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { adoptedApprovalStoreSql } from "../../src/cli/rls-approvals.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

describe("rls.approvals on an adopted table", () => {
  it("keys the functions on the token column and reads every field from the body", () => {
    const sql = adoptedApprovalStoreSql(ctx, { table: "approvals" });
    expect(sql).toContain(
      'alter table "public"."approvals" add column if not exists "token" text;',
    );
    expect(sql).toContain(
      'create unique index if not exists "approvals_permdock_token" on "public"."approvals" ("token");',
    );
    expect(sql).toContain(`where a."body" ->> 'status' = 'pending'`);
    expect(sql).toContain(`set "body" = p_next\n  where`);
    expect(sql).not.toContain("enable row level security");
    expect(sql).not.toContain("pg_jsonschema");
  });

  it("mirrors one field with a plain assignment and several with a row assignment", () => {
    const one = adoptedApprovalStoreSql(ctx, {
      table: "app.requests",
      mirror: { status: "state" },
    });
    expect(one).toContain(
      `"state" = (select r."state" from pg_catalog.jsonb_populate_record(null::"app"."requests", pg_catalog.jsonb_build_object('state', p_next ->> 'status')) r)`,
    );
    const many = adoptedApprovalStoreSql(ctx, {
      table: "app.requests",
      mirror: { status: "state", approvals: "approval_count" },
    });
    expect(many).toContain(
      `("state", "approval_count") = (select r."state", r."approval_count"`,
    );
  });

  it("mirrors every request field it knows", () => {
    const fields = [
      "status",
      "permission",
      "tenant",
      "principalId",
      "actorId",
      "session",
      "approvals",
      "createdAt",
      "expiresAt",
      "resolvedAt",
      "resolvedBy",
      "consumedAt",
    ] as const;
    const sql = adoptedApprovalStoreSql(ctx, {
      table: "approvals",
      mirror: Object.fromEntries(fields.map((field) => [field, `m_${field}`])),
    });
    for (const field of fields.filter((item) => item !== "approvals")) {
      expect(sql).toContain(`'m_${field}', p_request`);
    }
    expect(sql).toContain(
      `'m_approvals', coalesce(jsonb_array_length(p_request -> 'approvals'), 0)`,
    );
  });

  it("adds the body check on the adopted column", () => {
    const sql = adoptedApprovalStoreSql(
      ctx,
      { table: "approvals", body: "request" },
      true,
    );
    expect(sql).toContain(
      'add constraint "approvals_permdock_body_schema" check (extensions.jsonb_matches_schema(',
    );
    expect(sql).toContain(`::json, "request")) not valid;`);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["an unknown field", { nope: "x" }, /is not a request field/u],
    ["a non-string column", { status: 5 }, /must be a column name/u],
    [
      "the token column",
      { status: "token" },
      /already holds the token or the body/u,
    ],
  ])("refuses a mirror of %s", (_label, mirror, error) => {
    expect(() =>
      // SAFETY: an untyped mirror, as a JavaScript config could hold it.
      adoptedApprovalStoreSql(ctx, {
        table: "approvals",
        mirror: mirror as never,
      }),
    ).toThrow(error);
  });
});
