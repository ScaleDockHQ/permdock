import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/has-memo");

const OPS = "00000000-0000-4000-8000-0000000000b1";
const AUDITOR = "00000000-0000-4000-8000-0000000000b2";
const MEMBER = "00000000-0000-4000-8000-0000000000b3";
const ROUNDS = 20;
const DISTINCT_GRANTS = 3;

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${OPS}'), ('${AUDITOR}'), ('${MEMBER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
create table public.board (id text primary key, "orgId" text not null, "teamId" text not null);
`;

const SEED = `
insert into public.organization_members values ('acme', '${MEMBER}', 'member');
insert into public.project values
  ('p-acme', 'acme', '${MEMBER}'), ('p-globex', 'globex', '${OPS}');
insert into public.task values
  ('t-acme', 'acme', '${MEMBER}', false), ('t-globex', 'globex', '${OPS}', false);
insert into public.board values ('b-acme', 'acme', 't1');
insert into permdock.user_roles values ('${OPS}', 'ops'), ('${AUDITOR}', 'support');
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect) values
  (null, 'global', null, 'ops', 'project.read', 'allow'),
  (null, 'global', null, 'ops', 'task.read', 'allow');
grant select on public.project, public.task, public.board to authenticated;

create function public.dashboard(p_rounds int)
returns void
language plpgsql
as $$
begin
  for i in 1..p_rounds loop
    perform count(*) from public.project;
    perform count(*) from public.task;
    perform count(*) from public.board;
    perform permdock.permdock_has_permission('project.read');
    perform permdock.permdock_has_permission('task.read');
    perform count(*) from permdock.permitted_tenant_ids_by_permission('task.read');
  end loop;
end;
$$;
grant execute on function public.dashboard(int) to authenticated;

create function public.read_around(p_write text)
returns table (first boolean, second boolean)
language plpgsql
as $$
begin
  first := permdock.permdock_has('project.read');
  execute p_write;
  second := permdock.permdock_has('project.read');
  return next;
end;
$$;
`;

const COUNTED = [
  "permdock_has",
  "permdock_custom_keys",
  "grant_keys",
  "permdock_has_permission",
  "permitted_tenant_ids",
] as const;

describe("permdock_has memo against Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-has-memo-"));
  let lite: PGlite | undefined;
  let sql = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    sql = readFileSync(out, "utf8");
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(sql);
    await lite.exec(SEED);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const rolledBack = async <T>(
    sub: string,
    work: (tx: PGlite) => Promise<T>,
  ): Promise<T> => {
    const db = database();
    await db.exec("begin");
    try {
      await db.exec("set local track_functions = 'all'");
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role: "authenticated" }),
      ]);
      await db.exec("set local role authenticated");
      return await work(db);
    } finally {
      await db.exec("rollback");
    }
  };

  const calls = async (tx: PGlite): Promise<Record<string, number>> => {
    const stats = await tx.query<{
      readonly funcname: string;
      readonly calls: number;
    }>(
      "select funcname, calls::int from pg_stat_xact_user_functions where schemaname = 'permdock'",
    );
    const all = Object.fromEntries(
      stats.rows.map((row) => [row.funcname, row.calls]),
    );
    const scans = await tx.query<{ readonly scans: number }>(
      "select (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::int as scans from pg_stat_xact_user_tables where schemaname = 'permdock' and relname = 'user_roles'",
    );
    return {
      ...Object.fromEntries(COUNTED.map((name) => [name, all[name] ?? 0])),
      user_roles: scans.rows[0]?.scans ?? 0,
    };
  };

  const counting = async (
    work: (tx: PGlite) => Promise<unknown>,
  ): Promise<Record<string, number>> =>
    rolledBack(OPS, async (tx) => {
      const before = await calls(tx);
      await work(tx);
      const after = await calls(tx);
      return Object.fromEntries(
        Object.keys(after).map((name) => [
          name,
          (after[name] ?? 0) - (before[name] ?? 0),
        ]),
      );
    });

  const visible = async (tx: PGlite, table: string): Promise<number> =>
    (
      await tx.query<{ readonly n: number }>(
        `select count(*)::int as n from public.${table}`,
      )
    ).rows[0]?.n ?? -1;

  it("memoizes permdock_has", () => {
    expect(sql).toContain(
      'create or replace function "permdock".permdock_has(p_grant text)\nreturns boolean\nlanguage plpgsql\nvolatile',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_has_for(p_user uuid, p_grant text)\nreturns boolean\nlanguage sql\nstable',
    );
  });

  it("answers the global custom role, the declared global role and a member", async () => {
    const answers = async (sub: string): Promise<readonly number[]> =>
      rolledBack(sub, async (tx) => [
        await visible(tx, "project"),
        await visible(tx, "task"),
        await visible(tx, "board"),
      ]);
    expect(await answers(OPS)).toStrictEqual([2, 2, 0]);
    expect(await answers(AUDITOR)).toStrictEqual([2, 2, 1]);
    expect(await answers(MEMBER)).toStrictEqual([1, 1, 0]);
  });

  it("runs the has body once per grant across the statements of one call", async () => {
    const counted = await counting(async (tx) =>
      tx.query("select public.dashboard($1)", [ROUNDS]),
    );
    expect(counted).toMatchObject({
      permdock_has: 5 * ROUNDS,
      grant_keys: 5 * ROUNDS,
      permdock_has_permission: 2 * ROUNDS,
      user_roles: 2 * DISTINCT_GRANTS,
    });
  });

  it("runs the has body again in the next statement", async () => {
    const counted = await counting(async (tx) => {
      await visible(tx, "project");
      await visible(tx, "project");
    });
    expect(counted).toMatchObject({ permdock_has: 2, user_roles: 4 });
  });

  it("sees a custom_role_permissions write in the next statement", async () => {
    const around = await rolledBack(OPS, async (tx) => {
      await tx.exec("reset role");
      const result = await tx.query<{
        readonly first: boolean;
        readonly second: boolean;
      }>("select * from public.read_around($1)", [
        "delete from permdock.custom_role_permissions where role = 'ops' and permission = 'project.read'",
      ]);
      return result.rows[0];
    });
    expect(around).toStrictEqual({ first: true, second: false });
    const granted = await rolledBack(MEMBER, async (tx) => {
      const before = await visible(tx, "project");
      await tx.exec("reset role");
      await tx.exec(
        `insert into permdock.user_roles values ('${MEMBER}', 'ops')`,
      );
      await tx.exec("set local role authenticated");
      return [before, await visible(tx, "project")];
    });
    expect(granted).toStrictEqual([1, 2]);
  });
});
