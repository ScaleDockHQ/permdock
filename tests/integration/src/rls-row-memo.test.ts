import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-memo");

const MEMBER = "00000000-0000-4000-8000-0000000000a1";
const BLOCKED = "00000000-0000-4000-8000-0000000000a2";
const READER = "00000000-0000-4000-8000-0000000000a3";
const SHARED = "00000000-0000-4000-8000-0000000000a4";
const OWNER = "00000000-0000-4000-8000-0000000000a5";
const USERS = [MEMBER, BLOCKED, READER, SHARED, OWNER] as const;
const PERMISSIONS = ["doc.read", "doc.update", "doc.create"] as const;
const BENCH = 60;

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
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
insert into auth.users (id) values
  ('${MEMBER}'), ('${BLOCKED}'), ('${READER}'), ('${SHARED}'), ('${OWNER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.doc (
  id text primary key,
  "orgId" text not null,
  "ownerId" uuid,
  locked boolean not null default false
);
create table public.file (id text primary key, "orgId" text not null);
create table public.doc_shares (doc_id text not null, user_id uuid not null);
`;

const SEED = `
insert into public.organization_members values
  ('acme', '${MEMBER}', 'member'),
  ('acme', '${BLOCKED}', 'member'),
  ('acme', '${BLOCKED}', 'blocked'),
  ('acme', '${READER}', 'reader');
insert into public.doc values
  ('d1', 'acme', '${OWNER}', false),
  ('d2', 'acme', '${MEMBER}', true),
  ('d3', 'acme', null, false),
  ('d4', 'beta', null, false);
insert into public.doc_shares values ('d3', '${READER}'), ('d3', '${SHARED}');
insert into public.doc
select 'b' || n, 'acme', null, false from generate_series(1, ${String(BENCH)}) n;
grant select, insert on public.doc to authenticated;
alter table public.doc enable row level security;
create policy doc_read on public.doc for select to authenticated
  using (permdock.permitted_doc_row(doc, 'doc.read'));
create policy doc_create on public.doc for insert to authenticated
  with check (permdock.permitted_doc_row(doc, 'doc.create'));

create function public.read_around(p_user uuid, p_doc text, p_write text)
returns table (first boolean, second boolean)
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  first := (select permdock.permitted_doc_row(d, 'doc.read') from public.doc d where d.id = p_doc);
  execute p_write;
  second := (select permdock.permitted_doc_row(d, 'doc.read') from public.doc d where d.id = p_doc);
  return next;
end;
$$;
`;

const CLAIMS = (sub: string): string =>
  JSON.stringify({ sub, role: "authenticated" });

describe("permitted_<resource>_row memo against Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-row-memo-"));
  let lite: PGlite | undefined;
  let sql = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
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
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        CLAIMS(sub),
      ]);
      return await work(db);
    } finally {
      await db.exec("rollback");
    }
  };

  const rowAnswers = async (
    tx: PGlite,
    permission: string,
  ): Promise<readonly string[]> =>
    (
      await tx.query<{ readonly id: string }>(
        "select d.id from public.doc d where permdock.permitted_doc_row(d, $1) order by d.id",
        [permission],
      )
    ).rows.map((row) => row.id);

  const idAnswers = async (
    tx: PGlite,
    permission: string,
  ): Promise<readonly string[]> =>
    (
      await tx.query<{ readonly id: string }>(
        "select d.id from public.doc d where permdock.permitted_doc_row(d.id, $1) order by d.id",
        [permission],
      )
    ).rows.map((row) => row.id);

  const setAnswers = async (
    tx: PGlite,
    permission: string,
  ): Promise<readonly string[]> =>
    (
      await tx.query<{ readonly id: string }>(
        "select r.id from permdock.permitted_doc_rows($1, array(select id from public.doc)) r(id) order by r.id",
        [permission],
      )
    ).rows.map((row) => row.id);

  it("memoizes the row helper", () => {
    expect(sql).toContain(
      'create or replace function "permdock".permitted_doc_row(p_row "public"."doc", p_permission text)\nreturns boolean\nlanguage plpgsql\nvolatile',
    );
    expect(sql).toContain(
      'create trigger "permdock_memo_generation"\n  after insert or update or delete on "public"."doc_shares"',
    );
    expect(sql).toContain(
      'create trigger "permdock_memo_generation"\n  after insert or update or delete on "public"."organization_members"',
    );
  });

  it("answers like the unmemoized compiled arms for every user and permission", async () => {
    for (const user of USERS) {
      for (const permission of PERMISSIONS) {
        await rolledBack(user, async (tx) => {
          const expected = await setAnswers(tx, permission);
          expect(await rowAnswers(tx, permission)).toStrictEqual(expected);
          expect(await idAnswers(tx, permission)).toStrictEqual(expected);
        });
      }
    }
  });

  it("allows, denies, overrides with a deny, follows a relation and checks requires", async () => {
    const read = async (user: string): Promise<readonly string[]> =>
      rolledBack(user, async (tx) =>
        (await rowAnswers(tx, "doc.read")).filter((id) => id.startsWith("d")),
      );
    expect(await read(MEMBER)).toStrictEqual(["d1", "d2", "d3"]);
    expect(await read(BLOCKED)).toStrictEqual(["d1", "d3"]);
    expect(await read(READER)).toStrictEqual(["d3"]);
    expect(await read(SHARED)).toStrictEqual([]);
    expect(await read(OWNER)).toStrictEqual([]);
    expect(
      await rolledBack(OWNER, async (tx) => rowAnswers(tx, "doc.update")),
    ).toStrictEqual(["d1"]);
  });

  it("sees a membership or share written earlier in the same statement", async () => {
    const around = async (
      user: string,
      id: string,
      write: string,
    ): Promise<{ readonly first: boolean; readonly second: boolean }> =>
      rolledBack(user, async (tx) => {
        const result = await tx.query<{
          readonly first: boolean;
          readonly second: boolean;
        }>("select * from public.read_around($1::uuid, $2, $3)", [
          user,
          id,
          write,
        ]);
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("PermDock: read_around returned no row");
        }
        return row;
      });
    expect(
      await around(
        READER,
        "d1",
        `insert into public.doc_shares values ('d1', '${READER}')`,
      ),
    ).toStrictEqual({ first: false, second: true });
    expect(
      await around(
        SHARED,
        "d3",
        `insert into public.organization_members values ('acme', '${SHARED}', 'reader')`,
      ),
    ).toStrictEqual({ first: false, second: true });
    expect(
      await around(
        MEMBER,
        "d1",
        `delete from public.organization_members where user_id = '${MEMBER}'`,
      ),
    ).toStrictEqual({ first: true, second: false });
    expect(
      await around(READER, "d3", "truncate public.doc_shares"),
    ).toStrictEqual({ first: true, second: false });
  });

  it("holds the answer inside the statement when no trigger bumps the memo", async () => {
    const result = await rolledBack(READER, async (tx) => {
      await tx.exec(
        'drop trigger "permdock_memo_generation" on public.doc_shares',
      );
      return tx.query<{ readonly first: boolean; readonly second: boolean }>(
        "select * from public.read_around($1::uuid, 'd1', $2)",
        [READER, `insert into public.doc_shares values ('d1', '${READER}')`],
      );
    });
    expect(result.rows[0]).toStrictEqual({ first: false, second: false });
  });

  it("checks the row an insert returns", async () => {
    const db = database();
    await db.exec("begin");
    try {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        CLAIMS(MEMBER),
      ]);
      const inserted = await db.query<{ readonly id: string }>(
        `insert into public.doc values ('n1', 'acme', '${MEMBER}', false), ('n2', 'acme', null, false) returning id`,
      );
      expect(inserted.rows.map((row) => row.id)).toStrictEqual(["n1", "n2"]);
      await expect(
        db.query("insert into public.doc values ('n3', 'beta', null, false)"),
      ).rejects.toThrow(/row-level security/u);
    } finally {
      await db.exec("rollback");
    }
  });

  it("runs the inner helpers once per statement, not once per row", async () => {
    const calls = await rolledBack(MEMBER, async (tx) => {
      await tx.exec("set local track_functions = 'all'");
      const rows = await rowAnswers(tx, "doc.read");
      const stats = await tx.query<{
        readonly funcname: string;
        readonly calls: number;
      }>(
        "select funcname, calls::int from pg_stat_xact_user_functions where schemaname = 'permdock'",
      );
      return {
        rows: rows.length,
        calls: Object.fromEntries(
          stats.rows.map((row) => [row.funcname, row.calls]),
        ),
      };
    });
    expect(calls.rows).toBe(BENCH + 3);
    expect(calls.calls).toMatchObject({
      permitted_doc_row: BENCH + 4,
      permitted_tenant_ids: 3,
      permitted_tenant_ids_by_permission: 1,
      permitted_doc_ids: 1,
      permdock_has_permission: 1,
    });
  });
});
