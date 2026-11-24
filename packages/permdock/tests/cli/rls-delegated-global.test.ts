import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PERMISSIONS, policyProject, removeProjects } from "./doctor-kit.ts";
import { rlsGenerate } from "./rls-call.ts";

const POLICY = `  roles: [
    role('admin', [allow(permissions.post.read)]),
    role('member', [allow(permissions.post.read)], { on: 'tenant' }),
  ],
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

const CLIENT_GATE = `coalesce(((select auth.jwt()) ->> 'client_id'), '') = ''`;
const KEY_GATE = `((select auth.jwt()) -> 'api_key') is null`;

function helper(sql: string, name: string): string {
  const start = sql.indexOf(`function "permdock".${name}(`);
  return sql.slice(start, sql.indexOf("$$;", start));
}

describe("rls generate gates global grants for delegated tokens", () => {
  afterAll(removeProjects);

  async function generate(
    rls: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const cwd = policyProject(
      { policy: POLICY },
      {
        "src/permissions.ts": PERMISSIONS,
        "permdock.config.ts": `export default ${JSON.stringify({
          permissions: "./src/permissions.ts",
          policy: "./src/policy.ts",
          rls: {
            dialect: "supabase",
            authorize: "database",
            scopeTypes: { tenant: "text" },
            tables: { post: "posts", note: "notes" },
            memberships: MEMBERSHIPS,
            ...rls,
          },
        })};\n`,
      },
    );
    const result = await rlsGenerate(["--out", "rls.sql"], { cwd });
    expect(result.stdout + result.stderr).not.toContain("error");
    return readFileSync(path.join(cwd, "rls.sql"), "utf8");
  }

  it("refuses global grants to API keys, OAuth clients and act chains when no cap is configured", async () => {
    const has = helper(await generate({}), "permdock_has");
    expect(has).toContain(KEY_GATE);
    expect(has).toContain(CLIENT_GATE);
    expect(has).toContain(`((select auth.jwt()) -> 'act') is null`);
  });

  it("leaves each token type to its cap once rls.apiKeys and rls.tokenScopes are set", async () => {
    const has = helper(
      await generate({ apiKeys: {}, tokenScopes: true }),
      "permdock_has",
    );
    expect(has).not.toContain(CLIENT_GATE);
    expect(has).not.toContain(`((select auth.jwt()) -> 'act') is null`);
  });

  it("keeps the gate off the scoped helpers and the helpers for a named user", async () => {
    const sql = await generate({});
    expect(helper(sql, "permitted_tenant_ids")).not.toContain(CLIENT_GATE);
    expect(helper(sql, "permdock_has_for")).not.toContain(CLIENT_GATE);
  });
});
