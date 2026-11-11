import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PERMISSIONS, policyProject, removeProjects } from "./doctor-kit.ts";
import { rlsGenerate } from "./rls-call.ts";

const MARKED = PERMISSIONS.replace(
  "actions: ['read', 'update', 'delete', 'approve', 'pay', 'transfer'],",
  "actions: { read: {}, update: {}, delete: {}, approve: {}, pay: {}, transfer: { interactiveOnly: true } },",
);

const POLICY = `  roles: [
    role('owner', [allow([permissions.post.read, permissions.post.transfer])], { on: 'tenant', transferOnly: true, assigns: ['owner', 'member'] }),
    role('member', [allow(permissions.post.read)], { on: 'tenant' }),
  ],
  grants: [allow(permissions.post.transfer, { to: authenticated(), requires: permissions.post.read })],
  scopes: { tenant: { key: 'orgId' } },`;

const MEMBERSHIPS = {
  scopes: {
    tenant: {
      table: "tenant_members",
      user: "user_id",
      role: "role",
      columns: { tenant: "tenant_id" },
    },
  },
};

describe("rls generate with interactive-only permissions", () => {
  afterAll(removeProjects);

  async function generate(
    rls: Readonly<Record<string, unknown>>,
    permissions = MARKED,
  ): Promise<string> {
    const cwd = policyProject(
      { policy: POLICY },
      {
        "src/permissions.ts": permissions,
        "permdock.config.ts": `export default ${JSON.stringify({
          permissions: "./src/permissions.ts",
          policy: "./src/policy.ts",
          rls: {
            scopeTypes: { tenant: "text" },
            tables: { post: "posts", note: "notes" },
            actions: { transfer: "update", approve: "update", pay: "update" },
            ...rls,
          },
        })};\n`,
      },
    );
    const result = await rlsGenerate(["--out", "rls.sql"], { cwd });
    expect(result.stdout + result.stderr).not.toContain("error");
    return readFileSync(path.join(cwd, "rls.sql"), "utf8");
  }

  it("refuses the marked keys to delegated tokens in the helpers, policies, memo and can_assign", async () => {
    const sql = await generate({
      dialect: "supabase",
      authorize: "database",
      memo: "permdock",
      apiKeys: { claim: "key" },
      memberships: MEMBERSHIPS,
    });
    expect(sql).toContain(
      `create or replace function "permdock".permdock_interactive_allows(p_grant text)`,
    );
    expect(sql).toContain(`<> all (array['post.transfer']::text[])`);
    expect(sql).toContain(`((select auth.jwt()) -> 'api_key') is null`);
    expect(sql).toContain(`((select auth.jwt()) -> 'key') is null`);
    expect(sql).toContain(`"permdock".permdock_interactive_allows(p_grant)`);
    expect(sql).toContain(
      `(select "permdock".permdock_interactive_allows('post.transfer'))`,
    );
    expect(sql).not.toContain(`permdock_interactive_allows('post.read')`);
    expect(sql).toContain(`else '|delegated' end)`);
    expect(sql).toContain(`(p_role <> all (array['owner']::text[]) or (`);
    expect(sql).toContain(
      `grant execute on function "permdock".permdock_interactive_allows(text) to authenticated;`,
    );
    const forHelper = sql.slice(
      sql.indexOf("permitted_tenant_ids_for("),
      sql.indexOf("$$;", sql.indexOf("permitted_tenant_ids_for(")),
    );
    expect(forHelper).not.toContain("permdock_interactive_allows");
  });

  it("reads the claims from settings on the GUC dialect and lets anon execute with rls.anonExecute", async () => {
    const sql = await generate({
      dialect: "guc",
      authorize: "jwt",
      anonExecute: true,
    });
    expect(sql).toContain(
      `coalesce((select current_setting('app.client_id', true)), '') = ''`,
    );
    expect(sql).toContain(
      `grant execute on function "permdock".permdock_interactive_allows(text) to anon, authenticated;`,
    );
  });

  it("writes nothing new when no key is marked", async () => {
    const sql = await generate(
      { dialect: "supabase", authorize: "database", memberships: MEMBERSHIPS },
      PERMISSIONS,
    );
    expect(sql).not.toContain("interactive");
    expect(sql).not.toContain("|delegated");
  });
});
