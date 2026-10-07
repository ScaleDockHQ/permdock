import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { rowHelpersSql, rowsHelper } from "../../src/cli/rls-rows.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read", "update", "archive"],
    collection: ["create"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
    },
  }),
  note: resource({ actions: ["read"] }),
});

const { doc } = permissions;

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow([doc.read, doc.create])], { on: "tenant" }),
    role("blocked", [deny(doc.read, { where: { locked: true } })], {
      on: "tenant",
    }),
  ],
  grants: [allow([doc.update, doc.archive], { to: relation(doc, "owner") })],
  subject: () => null,
});

function context(dialect: RlsSqlContext["dialect"]): RlsSqlContext {
  return {
    dialect,
    scopes: scopeList(policy.scopes),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
  };
}

function generate(
  dialect: RlsSqlContext["dialect"],
  select: true | readonly string[] = true,
): { readonly sql: string; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const ctx = context(dialect);
  const compiled = compileGrants(policy, ctx, undefined, warnings, false, true);
  const sql = rowHelpersSql(
    ctx,
    policy,
    [...compiled.branches, ...compiled.actionBranches],
    select,
    { doc: "app.documents" },
    warnings,
  );
  return { sql, warnings };
}

describe("permitted_<resource>_rows", () => {
  it("cases each permission over its allows and denies, actions without a SQL command included", () => {
    const { sql, warnings } = generate("supabase", ["doc", "note"]);
    expect(generate("supabase").sql).not.toContain("permitted_note_rows");
    expect(sql).toContain('"permdock".permitted_doc_rows(p_permission text)');
    expect(sql).toContain('select "id"::text from "app"."documents"');
    expect(sql).toContain(
      `when 'doc.read' then coalesce(("orgId" in (select "permdock".permitted_tenant_ids('doc.read#1'))), false) and (("orgId" in (select "permdock".permitted_tenant_ids('doc.read#2'))) and ("locked" = true)) is not true`,
    );
    expect(sql).toContain(
      `when 'doc.archive' then coalesce(("ownerId" = (select "permdock".permdock_user_id())), false)`,
    );
    expect(sql).toContain(`when 'doc.update' then`);
    expect(sql).not.toContain(`when 'doc.create'`);
    expect(sql).toContain("    else false");
    expect(sql).toContain(
      '"permdock".permitted_doc_rows_for(p_user uuid, p_permission text, p_claims jsonb',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permitted_doc_rows_for(uuid, text, jsonb) from public, anon, authenticated;',
    );
    expect(sql).toContain('"permdock".permitted_note_rows');
    expect(sql).toMatch(
      /permitted_note_rows\(p_permission text\)[^$]*\$\$\n {2}select "id"::text from "public"."note"\n {2}where false\n\$\$/u,
    );
    expect(warnings.join("\n")).toContain(
      "no policy for authenticated/doc.archive: action 'archive' has no SQL command (rls.actions); only permitted_<resource>_rows answers it",
    );
  });

  it("sets the guc user and claims for a named user and restores them", () => {
    const { sql } = generate("guc", ["doc"]);
    expect(sql).toContain("p_user text, p_permission text, p_claims jsonb");
    expect(sql).toContain(
      "pg_catalog.set_config('app.' || v_key, v_value, true)",
    );
    expect(sql).not.toContain("permitted_note_rows");
  });

  it("writes no _for form for neon and says why", () => {
    const { sql, warnings } = generate("neon", ["doc"]);
    expect(sql).not.toContain("permitted_doc_rows_for");
    expect(warnings.at(-1)).toMatch(/neon dialect reads the subject/u);
  });

  it("refuses an undeclared resource and a name SQL cannot hold", () => {
    expect(() => generate("supabase", ["ghost"])).toThrow(
      "rls.rowHelpers names 'ghost', which the policy does not declare",
    );
    expect(() => rowsHelper("odd-name")).toThrow(/cannot name a helper/u);
    expect(() => rowsHelper(`r${"x".repeat(50)}`)).toThrow(/at most 45 bytes/u);
    expect(rowsHelper("chatThread")).toBe("permitted_chat_thread_rows");
  });
});
