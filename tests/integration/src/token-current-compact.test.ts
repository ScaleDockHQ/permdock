import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { run } from "./support/cli-run.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const USER = id(0xa2);
const ORGS = Array.from({ length: 30 }, (_, i) => id(0xb00 + i));

function setup(count: number): string {
  const orgs = ORGS.slice(0, count);
  return `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to supabase_auth_admin, authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${USER}');
create table memberships (user_id uuid not null, org_id uuid not null, role text not null);
insert into memberships values ${orgs.map((org) => `('${USER}', '${org}', 'member')`).join(", ")};
create table docs (id uuid primary key, org_id uuid not null);
grant select on memberships to supabase_auth_admin;
`;
}

const POLICY = `import { allow, definePermissions, definePolicy, resource, role } from "permdock";
export const permissions = definePermissions({
  doc: resource({ actions: ["read"], relations: { org: { field: "org_id", memberOf: "tenant" } } }),
});
export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "org_id" } },
  subject: () => null,
  roles: [role("member", [allow(permissions.doc.read)], { on: "tenant" })],
});
`;

function configText(memo: boolean): string {
  return `import { junctionMembershipSource } from "permdock/supabase";
const source = junctionMembershipSource({ table: "memberships", scope: "tenant", id: "org_id", roles: "role", user: "user_id" });
export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    authorize: "database",${memo ? '\n    memo: "permdock",' : ""}
    scopeTypes: { tenant: "uuid" },
    tables: { doc: "docs" },
    memberships: { scopes: { tenant: { table: "memberships", user: "user_id", role: "role", columns: { tenant: "org_id" } } } },
  },
  supabase: { hook: { memberships: [source] } },
};
`;
}

async function generate(memo: boolean): Promise<string[]> {
  const fixture = mkdtempSync(join(HERE, "../tmp-token-current-"));
  writeFileSync(join(fixture, "policy.ts"), POLICY);
  writeFileSync(join(fixture, "permdock.config.ts"), configText(memo));
  const dir = mkdtempSync(join(tmpdir(), "permdock-token-current-"));
  const files = ["helpers.sql", "seeds.sql", "policies.sql", "hook.sql"];
  try {
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--rbac",
        "supabase",
        "--schemas",
        "migra",
        "--split",
        "helpers,seeds,policies,hook",
        "--out",
        `${dir}/{part}.sql`,
        "--seeds-out",
        `${dir}/seeds.sql`,
        "--grants-out",
        `${dir}/grants.sql`,
      ],
      { cwd: fixture },
    );
    if (result.code !== 0) {
      throw new Error(result.stdout + result.stderr);
    }
    return [...files, "grants.sql"].map((file) =>
      readFileSync(join(dir, file), "utf8"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * The claims-first fast path with the claim the hook mints: the compact `{ s,
 * r, v, e, o }` memberships object counts as a current claim.
 */
describe("permdock_token_current with the hook's compact claim", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([setup(2), ...(await generate(false))]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("is current for an untruncated compact claim", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    // A user whose authorization changed once, so the hook mints authz_ver 1.
    await target.admin.query(
      "insert into permdock.permdock_authz_version (user_id, version) values ($1, 1)",
      [USER],
    );
    const claims = await target.as(
      { role: "supabase_auth_admin" },
      async () =>
        (
          await target.tester.query<{
            hook: { claims: Record<string, unknown> };
          }>(
            "select permdock.custom_access_token_hook(jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb)) as hook",
            [USER],
          )
        ).rows[0]?.hook.claims,
    );
    expect(Array.isArray(claims?.["memberships"])).toBe(false);
    expect(claims?.["memberships_truncated"]).not.toBe(true);
    const current = await target.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({
            ...claims,
            sub: USER,
            role: "authenticated",
          }),
        },
      },
      async () =>
        (
          await target.tester.query<{ current: boolean }>(
            "select permdock.permdock_token_current() as current",
          )
        ).rows[0]?.current,
    );
    expect(current).toBe(true);
  });
});
