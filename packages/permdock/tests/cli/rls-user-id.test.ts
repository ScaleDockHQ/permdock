import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import { policyModule, policyProject, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = `  roles: [
    role('member', [allow([permissions.post.read, permissions.post.update])], { on: 'tenant' }),
    role('admin', [allow(permissions.post.delete)]),
  ],
  grants: [
    allow(permissions.note.read, { to: authenticated() }),
    allow(permissions.post.update, { to: authenticated(), where: { authorId: principal.id } }),
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

const FUNCTION = `-- the caller's user id: auth.uid(), or null when the token's sub is empty
create or replace function "permdock".permdock_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when nullif(current_setting('request.jwt.claim.sub', true), '') is null
      and (select auth.jwt()) ->> 'sub' = ''
    then null
    else (select auth.uid())
  end
$$;`;

async function generate(
  rls: Readonly<Record<string, unknown>>,
  policy = policyModule(POLICY),
): Promise<string> {
  const cwd = policyProject(
    {},
    {
      "src/policy.ts": policy,
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
  const result = await run(["rls", "generate", "--out", "rls.sql"], { cwd });
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
  }
  return readFileSync(path.join(cwd, "rls.sql"), "utf8");
}

function outsideFunction(sql: string): string {
  const start = sql.indexOf(FUNCTION);
  return sql.slice(0, start) + sql.slice(start + FUNCTION.length);
}

const MODES: readonly (readonly [string, Readonly<Record<string, unknown>>])[] =
  [
    ["jwt", { authorize: "jwt" }],
    ["jwt, tenants all", { authorize: "jwt", tenants: "all" }],
    ["jwt, api keys", { authorize: "jwt", apiKeys: true }],
    ["database", { authorize: "database", memberships: MEMBERSHIPS }],
    [
      "database, tenants all, api keys",
      {
        authorize: "database",
        tenants: "all",
        apiKeys: { serviceRoles: ["member"] },
        memberships: MEMBERSHIPS,
      },
    ],
  ];

describe("permdock_user_id", () => {
  it.each(MODES)(
    "reads the subject through one helper in %s mode",
    async (_mode, rls) => {
      const sql = await generate({ dialect: "supabase", ...rls });
      expect(sql.split(FUNCTION)).toHaveLength(2);
      expect(sql.indexOf(FUNCTION)).toBeLessThan(
        sql.indexOf('"permdock".permdock_has('),
      );
      const rest = outsideFunction(sql);
      expect(rest).not.toContain("auth.uid()");
      expect(rest).not.toContain("->> 'sub'");
      expect(
        rest.split('(select "permdock".permdock_user_id())').length,
      ).toBeGreaterThan(3);
      expect(rest).toContain(
        `("authorId" = (select "permdock".permdock_user_id()))`,
      );
      expect(rest).toContain(
        'revoke execute on function "permdock".permdock_user_id() from public, anon;\ngrant execute on function "permdock".permdock_user_id() to authenticated;',
      );
    },
  );

  it("keeps the service-key branch on an empty subject", async () => {
    const sql = await generate({
      dialect: "supabase",
      apiKeys: { serviceRoles: ["member"] },
    });
    expect(sql).toContain(
      `coalesce((select "permdock".permdock_user_id())::text, '') = ''`,
    );
  });

  it("follows rls.schema and rls.anonExecute", async () => {
    const sql = await generate({
      dialect: "supabase",
      schema: "authz",
      anonExecute: true,
    });
    expect(sql).toContain(
      'create or replace function "authz".permdock_user_id()',
    );
    expect(sql).toContain(
      'revoke execute on function "authz".permdock_user_id() from public;\ngrant execute on function "authz".permdock_user_id() to anon, authenticated;',
    );
    expect(sql).not.toContain('"permdock".permdock_user_id');
  });

  it("lets anon run it when an anyone() policy reads the subject", async () => {
    const policy = policyModule(POLICY)
      .replace("import {", "import { anyone,")
      .replace(
        "allow(permissions.note.read, { to: authenticated() }),",
        "allow(permissions.post.read, { to: anyone(), where: { authorId: principal.id } }),",
      );
    const sql = await generate({ dialect: "supabase" }, policy);
    expect(sql).toContain(
      `  to anon\n  using ("authorId" = (select "permdock".permdock_user_id()));`,
    );
    expect(sql).toContain(
      'grant usage on schema "permdock" to anon, authenticated;',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_user_id() to anon, authenticated;',
    );
  });

  it.each(["neon", "guc"])(
    "is not written for the %s dialect",
    async (dialect) => {
      const sql = await generate({ dialect });
      expect(sql).not.toContain("permdock_user_id");
    },
  );
});
