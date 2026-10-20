import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = `  roles: [
    role('member', [allow([permissions.post.read, permissions.post.update])], { on: 'tenant' }),
    role('admin', [allow(permissions.post.delete)]),
  ],
  grants: [
    allow(permissions.note.read, { to: authenticated() }),
    deny(permissions.post.update, { to: authenticated(), where: { title: 'locked' } }),
  ],
  oauthScopes: { 'posts:write': [permissions.post.read, permissions.post.update] },
  scopes: { tenant: { key: 'orgId' } },`;

function generate(rls: Readonly<Record<string, unknown>>): Promise<{
  readonly code: number;
  readonly sql: string;
  readonly out: string;
}> {
  const cwd = policyProject(
    { policy: POLICY },
    {
      "permdock.config.ts": `export default ${JSON.stringify({
        permissions: "./src/permissions.ts",
        policy: "./src/policy.ts",
        rls: {
          tenantType: "text",
          tables: { post: "posts", note: "notes" },
          ...rls,
        },
      })};\n`,
    },
  );
  return run(["rls", "generate", "--out", "rls.sql"], { cwd }).then(
    (result) => ({
      code: result.code,
      out: result.stdout + result.stderr,
      sql:
        result.code === 0
          ? readFileSync(path.join(cwd, "rls.sql"), "utf8")
          : "",
    }),
  );
}

describe("rls generate with rls.tokenScopes", () => {
  it("writes the helper with the scope map and caps every helper and helper-free allow", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      tokenScopes: true,
    });
    expect(code).toBe(0);
    expect(sql).toContain(
      'create or replace function "permdock".permdock_token_scope_allows(p_grant text)',
    );
    expect(sql).toContain(`"posts:write":["post.read","post.update"]`);
    expect(sql).toContain(`"post:delete":["post.delete"]`);
    expect(sql).toContain(
      `when coalesce(((select auth.jwt()) ->> 'client_id'), '') = ''`,
    );
    expect(sql).toContain(`->> 'kind' in ('support', 'impersonation')`);
    expect(sql).toContain(
      `select "permdock".permdock_token_scope_allows(p_grant) and coalesce((`,
    );
    expect(sql).toContain(
      `  ) ids(id)\n  where "permdock".permdock_token_scope_allows(p_grant)`,
    );
    expect(sql).toContain(
      `(select "permdock".permdock_token_scope_allows('note.read'))`,
    );
    expect(sql).not.toContain(`permdock_token_scope_allows('post.update')`);
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_token_scope_allows(text) to authenticated;',
    );
  });

  it("chains with the API-key ceiling", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      tokenScopes: true,
      apiKeys: true,
    });
    expect(code).toBe(0);
    expect(sql).toContain(
      `select "permdock".permdock_api_key_allows(p_grant) and "permdock".permdock_token_scope_allows(p_grant) and nullif(`,
    );
    expect(sql).toContain(
      `((select "permdock".permdock_api_key_allows('note.read')) and (select "permdock".permdock_token_scope_allows('note.read')))`,
    );
  });

  it("reads the scope claim as text on the GUC dialect", async () => {
    const { code, sql } = await generate({
      dialect: "guc",
      authorize: "jwt",
      tokenScopes: true,
    });
    expect(code).toBe(0);
    expect(sql).toContain(
      `regexp_split_to_table(btrim(coalesce((select current_setting('app.scope', true)), '')), '\\s+') s(scope)`,
    );
  });

  it("does not narrow the _for helpers, which name their user", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      authorize: "database",
      tenants: "all",
      tokenScopes: true,
      memberships: {
        scopes: {
          tenant: {
            table: "tenant_members",
            user: "user_id",
            role: "role",
            columns: { tenant: "tenant_id" },
          },
        },
      },
    });
    expect(code).toBe(0);
    const forHelper = sql.slice(
      sql.indexOf("permitted_tenant_ids_for("),
      sql.indexOf("$$;", sql.indexOf("permitted_tenant_ids_for(")),
    );
    expect(forHelper).not.toContain("permdock_token_scope_allows");
  });

  it("leaves the helpers as they were with rls.tokenScopes off", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      tokenScopes: false,
    });
    expect(code).toBe(0);
    expect(sql).not.toContain("permdock_token_scope_allows");
  });

  it("refuses a value that is not a boolean", async () => {
    const { code, out } = await generate({
      dialect: "supabase",
      tokenScopes: "yes",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("rls.tokenScopes must be true or false");
  });
});
