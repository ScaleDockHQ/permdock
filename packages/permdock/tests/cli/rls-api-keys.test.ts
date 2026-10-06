import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { apiKeysPlan } from "../../src/cli/rls-api-keys.ts";
import { run } from "../../src/cli/run.ts";
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

describe("apiKeysPlan", () => {
  it("defaults the claim and field names and keeps the renames", () => {
    expect(apiKeysPlan(undefined, new Set(), {})).toBeUndefined();
    expect(apiKeysPlan(true, new Set(), {})).toEqual({
      claim: "api_key",
      scopes: "scopes",
      tenant: "tenant",
      roles: "roles",
      serviceRoles: [],
    });
    expect(
      apiKeysPlan(
        {
          claim: "credential",
          tenant: "organization_id",
          serviceRoles: ["viewer", "viewer"],
        },
        new Set(["viewer"]),
        { "doc.view": "doc.read" },
      ),
    ).toEqual({
      claim: "credential",
      scopes: "scopes",
      tenant: "organization_id",
      roles: "roles",
      serviceRoles: ["viewer"],
      renamed: { "doc.view": "doc.read" },
    });
  });

  it("refuses an unsafe field name and an undeclared service role", () => {
    expect(() => apiKeysPlan({ scopes: "x'; drop" }, new Set(), {})).toThrow(
      "rls.apiKeys.scopes must be a claim field name",
    );
    expect(() =>
      apiKeysPlan({ serviceRoles: ["ghost"] }, new Set(["viewer"]), {}),
    ).toThrow(
      "rls.apiKeys.serviceRoles names roles the policy does not declare: ghost",
    );
  });
});

describe("rls generate with rls.apiKeys", () => {
  it("caps the helpers, adds the tenant-key branch and caps allows that call no helper", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      apiKeys: { serviceRoles: ["member"] },
    });
    expect(code).toBe(0);
    expect(sql).toContain(
      'create or replace function "permdock".permdock_api_key_allows(p_grant text)',
    );
    expect(sql).toContain(
      `select "permdock".permdock_api_key_allows(p_grant) and nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '') is null and coalesce((`,
    );
    expect(sql).toContain(
      `  ) ids(id)\n  where "permdock".permdock_api_key_allows(p_grant)`,
    );
    expect(sql).toContain(
      `case jsonb_typeof(k -> 'roles') when 'array' then k -> 'roles' else '["member"]'::jsonb end`,
    );
    expect(sql).toContain(
      `(select "permdock".permdock_api_key_allows('note.read'))`,
    );
    expect(sql).not.toContain(`permdock_api_key_allows('post.update')`);
    expect(sql).not.toContain("auth.uid()");
    expect(sql).toContain(
      "(select nullif((select auth.jwt()) ->> 'sub', '')::uuid)",
    );
  });

  it("caps the claim-reading helpers in jwt mode and reads the GUC claim", async () => {
    const { code, sql } = await generate({
      dialect: "guc",
      authorize: "jwt",
      apiKeys: { claim: "credential", scopes: "permissions" },
    });
    expect(code).toBe(0);
    expect(sql).toContain(
      `from (select nullif((select current_setting('app.credential', true)), '')::jsonb as k) api_key`,
    );
    expect(sql).toContain(`jsonb_array_elements_text(k -> 'permissions')`);
    expect(sql).toContain(
      `  ) ids(id)\n  where "permdock".permdock_api_key_allows(p_grant)`,
    );
  });

  it("narrows user keys to the key's tenant with rls.tenants all", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      tenants: "all",
      apiKeys: true,
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
    const named = `nullif(((select auth.jwt()) -> 'api_key') ->> 'tenant', '')`;
    expect(sql).toContain(
      `    and (${named} is null or (m."tenant_id")::text = ${named})`,
    );
    expect(sql).toContain(
      `select "permdock".permdock_api_key_allows(p_grant) and ${named} is null and coalesce((`,
    );
  });

  it("narrows the claim-reading helpers to the key's tenant in jwt mode", async () => {
    const { code, sql } = await generate({
      dialect: "guc",
      authorize: "jwt",
      tenants: "all",
      apiKeys: { tenant: "org" },
    });
    expect(code).toBe(0);
    const named = `nullif(nullif((select current_setting('app.api_key', true)), '')::jsonb ->> 'org', '')`;
    expect(sql).toContain(
      `    and m ->> 'id' is not null\n    and (${named} is null or (m ->> 'id')::text = ${named})`,
    );
  });

  it("does not narrow the _for helpers, which name their user", async () => {
    const { code, sql } = await generate({
      dialect: "supabase",
      authorize: "database",
      tenants: "all",
      apiKeys: true,
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
    expect(forHelper).not.toContain("api_key");
  });

  it("leaves the helpers as they were without rls.apiKeys", async () => {
    const { code, sql } = await generate({ dialect: "supabase" });
    expect(code).toBe(0);
    expect(sql).not.toContain("permdock_api_key_allows");
    expect(sql).toContain("(select auth.uid())");
  });

  it("refuses an undeclared service role", async () => {
    const { code, out } = await generate({
      dialect: "supabase",
      apiKeys: { serviceRoles: ["ghost"] },
    });
    expect(code).not.toBe(0);
    expect(out).toContain(
      "rls.apiKeys.serviceRoles names roles the policy does not declare: ghost",
    );
  });
});
