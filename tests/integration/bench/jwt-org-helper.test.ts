import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { run } from "../src/support/cli-run.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/supabase-rbac");

const ROWS = 30_000;
const TENANTS = 60;
const RUNS = 9;
const MEMBER = "00000000-0000-4000-8000-000000000fff";

/** Token sizes in bytes and the membership counts of the plan's matrix. */
const TOKEN_BYTES = [512, 2048, 4096] as const;
const MEMBERSHIPS = [3, 11, 60] as const;

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${MEMBER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create index on public.organization_members (user_id);
grant select on public.organization_members to authenticated;
create table public.post (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null
);
insert into public.post
  select 'p' || n, 'org-' || lpad((n % ${TENANTS})::text, 2, '0'), '${MEMBER}'::uuid
  from generate_series(1, ${ROWS}) n;
create index on public.post ("orgId");
`;

type Explain = { readonly "Execution Time": number };

type Cell = {
  readonly tokenBytes: number;
  readonly memberships: number;
  readonly claimsFirstMs: number;
  readonly tableOnlyMs: number;
};

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function generate(authorize: "database" | "jwt"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-jwt-bench-"));
  const out = join(dir, "rls.sql");
  const result = await run(
    [
      "rls",
      "generate",
      "--target",
      "sql",
      "--dialect",
      "supabase",
      "--rbac",
      "supabase",
      "--authorize",
      authorize,
      "--memberships",
      "organization_members:organization_id,user_id,role",
      "--out",
      out,
    ],
    { cwd: FIXTURE },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}`);
  }
  const sql = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

/**
 * Claims of a user in `count` organisations, padded with one extra claim up to
 * `bytes`.
 */
function claimsOf(count: number, bytes: number): string {
  const base = {
    sub: MEMBER,
    role: "authenticated",
    memberships: Array.from({ length: count }, (_, index) => ({
      scope: "tenant",
      id: `org-${String(index).padStart(2, "0")}`,
      roles: ["member"],
    })),
    pad: "",
  };
  const missing = bytes - Buffer.byteLength(JSON.stringify(base));
  return JSON.stringify({ ...base, pad: "x".repeat(Math.max(missing, 0)) });
}

describe("the organisation helper by token size and membership count", () => {
  let db: Postgres | undefined;
  const cells: Cell[] = [];
  const mismatches: string[] = [];

  async function asMember<T>(
    claims: string,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    const target = defined(db);
    return target.as(
      { role: "authenticated", settings: { "request.jwt.claims": claims } },
      () => work(target.tester),
    );
  }

  async function measure(
    claims: string,
  ): Promise<{ readonly ids: readonly string[]; readonly medianMs: number }> {
    const ids = await asMember(claims, async (client) => {
      const result = await client.query<{ id: string }>(
        "select id from public.post order by id",
      );
      return result.rows.map((row) => row.id);
    });
    const times: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const plan = await asMember(claims, async (client) => {
        const result = await client.query<{ "QUERY PLAN": Explain[] }>(
          "explain (analyze, format json) select id from public.post",
        );
        return result.rows[0]?.["QUERY PLAN"][0];
      });
      if (plan === undefined) {
        throw new Error("PermDock: EXPLAIN returned no plan");
      }
      times.push(plan["Execution Time"]);
    }
    return { ids, medianMs: median(times) };
  }

  async function install(sql: string): Promise<void> {
    await defined(db).admin.query(
      "drop schema if exists permdock cascade; do $$ declare p record; begin for p in select policyname from pg_policies where tablename = 'post' loop execute format('drop policy %I on public.post', p.policyname); end loop; end $$;",
    );
    await defined(db).admin.query(sql);
  }

  beforeAll(async () => {
    const [database, jwt] = await Promise.all([
      generate("database"),
      generate("jwt"),
    ]);
    db = await startPostgres([SETUP, database, "analyze"]);
    for (const count of MEMBERSHIPS) {
      await defined(db).admin.query(
        `delete from public.organization_members;
         insert into public.organization_members
           select 'org-' || lpad(n::text, 2, '0'), '${MEMBER}'::uuid, 'member'
           from generate_series(0, ${String(count)} - 1) n;
         analyze public.organization_members`,
      );
      for (const bytes of TOKEN_BYTES) {
        const claims = claimsOf(count, bytes);
        await install(jwt);
        const first = await measure(claims);
        await install(database);
        const table = await measure(claims);
        if (first.ids.join(",") !== table.ids.join(",")) {
          mismatches.push(
            `${String(count)} memberships, ${String(bytes)} bytes`,
          );
        }
        cells.push({
          tokenBytes: bytes,
          memberships: count,
          claimsFirstMs: first.medianMs,
          tableOnlyMs: table.medianMs,
        });
      }
    }
  }, 900_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("returns the same rows claims-first and from the table", () => {
    expect(mismatches).toStrictEqual([]);
    expect(cells).toHaveLength(TOKEN_BYTES.length * MEMBERSHIPS.length);
  });

  it("reports the median execution time of each cell", async ({ annotate }) => {
    const version = await defined(db).admin.query<{ server_version: string }>(
      "show server_version",
    );
    const table = cells
      .map(
        (cell) =>
          `${String(cell.memberships)} memberships ${String(cell.tokenBytes)} B: claims-first ${cell.claimsFirstMs.toFixed(2)} ms, table ${cell.tableOnlyMs.toFixed(2)} ms`,
      )
      .join("; ");
    // Surfaced in the reporter; the numbers live in baselines/jwt-org-helper.json.
    await annotate(
      `jwt-org-helper: Postgres ${version.rows[0]?.server_version ?? "?"}, ${String(ROWS)} rows, median of ${String(RUNS)}: ${table}`,
    );
    for (const cell of cells) {
      expect(cell.claimsFirstMs).toBeGreaterThan(0);
      expect(cell.tableOnlyMs).toBeGreaterThan(0);
    }
  });
});
