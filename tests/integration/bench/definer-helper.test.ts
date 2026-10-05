import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { startPostgres } from "../src/support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/supabase-rbac");

const ROWS = 100_000;
const TENANTS = 20;
const RUNS = 9;
const MEMBER = "00000000-0000-4000-8000-000000000003";
const MEMBER_TENANT = "org-03";

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
insert into auth.users (id)
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
  from generate_series(0, ${TENANTS * 50 - 1}) n;
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
  select 'p' || n,
         'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         ('00000000-0000-4000-8000-' || lpad((n % ${TENANTS * 50})::text, 12, '0'))::uuid
  from generate_series(1, ${ROWS}) n;
create index on public.post ("orgId");

-- The hand-written shape: a permissions table a trigger keeps in step with
-- memberships, read per row by a security definer function.
create table public.role_permission_map (role text not null, permission text not null);
insert into public.role_permission_map values
  ('member', 'post.read'), ('member', 'post.list'), ('admin', 'post.read'), ('admin', 'post.list');
create table public.user_permissions (
  user_id uuid not null,
  organization_id text not null,
  permission text not null,
  primary key (user_id, organization_id, permission)
);
create function public.sync_user_permissions() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.user_permissions
    where user_id = old.user_id and organization_id = old.organization_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.user_permissions (user_id, organization_id, permission)
    select new.user_id, new.organization_id, m.permission
    from public.role_permission_map m where m.role = new.role
    on conflict do nothing;
  end if;
  return null;
end $$;
create trigger organization_members_permissions
  after insert or update or delete on public.organization_members
  for each row execute function public.sync_user_permissions();
create function public.has_permission(p_org text, p_permission text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_permissions
    where user_id = (select auth.uid()) and organization_id = p_org and permission = p_permission
  )
$$;
grant execute on function public.has_permission(text, text) to authenticated;

insert into public.organization_members
  select 'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         case when n < ${TENANTS} then 'member' else 'admin' end
  from generate_series(0, ${TENANTS * 50 - 1}) n;
`;

const DROP_POLICIES = `
do $$ declare p record; begin
  for p in select policyname from pg_policies where tablename = 'post' loop
    execute format('drop policy %I on public.post', p.policyname);
  end loop;
end $$;
`;

type PlanNode = {
  readonly "Actual Loops"?: number;
  readonly Plans?: readonly PlanNode[];
};

type Explain = {
  readonly Plan: PlanNode;
  readonly "Execution Time": number;
};

type Measured = {
  readonly ids: readonly string[];
  readonly medianMs: number;
};

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function generate(authorize: "database" | "jwt"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-bench-"));
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

describe("a per-row security definer helper against permitted_<scope>_ids", () => {
  let db: Postgres | undefined;
  const claims = {
    sub: MEMBER,
    role: "authenticated",
    memberships: [{ scope: "tenant", id: MEMBER_TENANT, roles: ["member"] }],
  };

  async function asMember<T>(work: (client: Client) => Promise<T>): Promise<T> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    return db.as(
      {
        role: "authenticated",
        settings: { "request.jwt.claims": JSON.stringify(claims) },
      },
      () => work(client),
    );
  }

  async function measure(): Promise<Measured> {
    const ids = await asMember(async (client) => {
      const result = await client.query<{ id: string }>(
        "select id from public.post order by id",
      );
      return result.rows.map((row) => row.id);
    });
    const times: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const plan = await asMember(async (client) => {
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

  let definer: Measured | undefined;
  let database: Measured | undefined;
  let jwt: Measured | undefined;

  beforeAll(async () => {
    const databaseSql = await generate("database");
    const jwtSql = await generate("jwt");
    db = await startPostgres([SETUP, databaseSql, "analyze"]);
    database = await measure();
    await db.admin.query(jwtSql);
    jwt = await measure();
    await db.admin.query(DROP_POLICIES);
    await db.admin.query(
      `create policy "post_select" on public.post for select to authenticated
         using (public.has_permission("orgId", 'post.read'))`,
    );
    definer = await measure();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("returns the same rows in every shape", () => {
    expect(database?.ids).toHaveLength(ROWS / TENANTS);
    expect(definer?.ids).toEqual(database?.ids);
    expect(jwt?.ids).toEqual(database?.ids);
  });

  it("reports the median execution time of each shape", async ({
    annotate,
  }) => {
    const version = await db!.admin.query<{ server_version: string }>(
      "show server_version",
    );
    // Surfaced in the reporter so the existing-apps page can quote the numbers.
    await annotate(
      `definer-bench: Postgres ${version.rows[0]?.server_version ?? "?"}, ${String(ROWS)} rows, ${String(TENANTS)} tenants, median of ${String(RUNS)}: per-row has_permission ${definer!.medianMs.toFixed(2)} ms, permitted_tenant_ids database ${database!.medianMs.toFixed(2)} ms, jwt ${jwt!.medianMs.toFixed(2)} ms`,
    );
    expect(database!.medianMs).toBeLessThan(definer!.medianMs);
    expect(jwt!.medianMs).toBeLessThan(definer!.medianMs);
  });
});
