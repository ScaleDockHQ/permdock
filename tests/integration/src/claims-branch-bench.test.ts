import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

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
  const fixture = mkdtempSync(join(HERE, "../tmp-claims-"));
  writeFileSync(join(fixture, "policy.ts"), POLICY);
  writeFileSync(join(fixture, "permdock.config.ts"), configText(memo));
  const dir = mkdtempSync(join(tmpdir(), "permdock-claims-"));
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

type Stat = { meanMs: number; p50Ms: number; p95Ms: number };

function stat(values: number[]): Stat {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { meanMs: round(mean), p50Ms: round(at(0.5)), p95Ms: round(at(0.95)) };
}

const dbs: Postgres[] = [];

/**
 * Times `permitted_tenant_ids` on its claims branch against its table branch,
 * with and without `rls.memo`, for 1 to 30 memberships. Opt-in: set
 * `PERMDOCK_CLAIMS_BENCH=1`; it writes `claims-branch.json` beside this
 * folder.
 */
describe.skipIf(process.env["PERMDOCK_CLAIMS_BENCH"] !== "1")(
  "claims branch against table branch",
  () => {
    afterAll(async () => {
      for (const db of dbs) {
        await db.stop();
      }
    });

    it("times permitted_tenant_ids", async () => {
      const out: Record<string, unknown> = {};
      for (const memo of [false, true]) {
        for (const count of [1, 8, 11, 30]) {
          const db = await startPostgres([
            setup(count),
            ...(await generate(memo)),
          ]);
          dbs.push(db);
          const key = (
            await db.admin.query<{ grant_key: string }>(
              "select grant_key from permdock.role_permissions where role = 'member' order by grant_key limit 1",
            )
          ).rows[0]?.grant_key;
          const versionColumns = (
            await db.admin.query<{ column_name: string }>(
              "select column_name from information_schema.columns where table_schema = 'permdock' and table_name = 'permdock_authz_version'",
            )
          ).rows.map((row) => row.column_name);
          if (versionColumns.length > 0) {
            await db.admin.query(
              `insert into permdock.permdock_authz_version (user_id, version) values ('${USER}', 1) on conflict do nothing`,
            );
          }
          const minted = await db.as(
            { role: "supabase_auth_admin" },
            async () => {
              const result = await db.tester.query<{
                event: { claims: Record<string, unknown> };
              }>(
                "select permdock.custom_access_token_hook($1::jsonb) as event",
                [
                  JSON.stringify({
                    user_id: USER,
                    claims: { sub: USER, role: "authenticated" },
                  }),
                ],
              );
              return result.rows[0]?.event.claims ?? {};
            },
          );
          const truncated = { ...minted, memberships_truncated: true };
          const time = async (
            claims: Record<string, unknown>,
            client: Client,
          ): Promise<{ ms: number; rows: number; current: boolean }> =>
            db.as(
              {
                role: "authenticated",
                settings: { "request.jwt.claims": JSON.stringify(claims) },
              },
              async () => {
                const plan = await client.query<{
                  "QUERY PLAN": [{ "Execution Time": number }];
                }>(
                  `explain (analyze, timing off, format json) select * from permdock.permitted_tenant_ids('${key ?? ""}')`,
                );
                const rows = await client.query(
                  `select * from permdock.permitted_tenant_ids('${key ?? ""}')`,
                );
                const current = await client.query<{ c: boolean }>(
                  "select permdock.permdock_token_current() as c",
                );
                return {
                  ms: plan.rows[0]?.["QUERY PLAN"][0]["Execution Time"] ?? 0,
                  rows: rows.rowCount ?? 0,
                  current: current.rows[0]?.c ?? false,
                };
              },
            );
          const claimsTimes: number[] = [];
          const tableTimes: number[] = [];
          let claimsInfo = { rows: 0, current: false };
          let tableInfo = { rows: 0, current: false };
          for (let i = 0; i < 300; i += 1) {
            const a = await time(minted, db.tester);
            const b = await time(truncated, db.tester);
            if (i >= 20) {
              claimsTimes.push(a.ms);
              tableTimes.push(b.ms);
            }
            claimsInfo = a;
            tableInfo = b;
          }
          await db.stop();
          dbs.pop();
          const mintedBytes = JSON.stringify(minted).length;
          out[`memo=${String(memo)} memberships=${String(count)}`] = {
            key,
            claimsBytes: mintedBytes,
            mintedTruncated: minted["memberships_truncated"] === true,
            mintedMemberships: Array.isArray(minted["memberships"])
              ? minted["memberships"].length
              : 0,
            claims: { ...stat(claimsTimes), ...claimsInfo },
            table: { ...stat(tableTimes), ...tableInfo },
          };
        }
      }
      writeFileSync(
        join(HERE, "../claims-branch.json"),
        `${JSON.stringify(out, null, 2)}\n`,
      );
    }, 900_000);
  },
);
