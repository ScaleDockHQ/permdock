import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODES = new Map<string, string>([
  ["permdock", join(HERE, "../fixtures/row-memo")],
  ["better-supabase", join(HERE, "../fixtures/row-memo-better-supabase")],
]);

const MEMBER = "00000000-0000-4000-8000-0000000000a1";
const BLOCKED = "00000000-0000-4000-8000-0000000000a2";
const READER = "00000000-0000-4000-8000-0000000000a3";
const SHARED = "00000000-0000-4000-8000-0000000000a4";
const OWNER = "00000000-0000-4000-8000-0000000000a5";
const USERS = [MEMBER, BLOCKED, READER, SHARED, OWNER] as const;
const PERMISSIONS = ["doc.read", "doc.update", "doc.create"] as const;
const BENCH = 60;

// The two functions better-supabase installs in the `better_supabase` schema.
const MEMO_FUNCTIONS = `
create schema better_supabase;
create function better_supabase.memo_get(key text) returns text
language sql volatile set search_path = '' as $$
  select nullif(pg_catalog.current_setting('better_supabase.memo.' || key, true), '')
$$;
create function better_supabase.memo_set(key text, value text) returns text
language sql volatile set search_path = '' as $$
  select pg_catalog.set_config('better_supabase.memo.' || key, value, true)
$$;
grant usage on schema better_supabase to authenticated, anon;
grant execute on all functions in schema better_supabase to authenticated, anon;
`;

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

type Answers = Record<string, readonly string[]>;

const CLAIMS = (sub: string): string =>
  JSON.stringify({ sub, role: "authenticated" });

describe("row helper memo modes answer the same", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-memo-modes-"));
  const sql = new Map<string, string>();
  const answers = new Map<string, Answers>();

  beforeAll(async () => {
    for (const [mode, cwd] of MODES) {
      const out = join(dir, `${mode}.sql`);
      const generated = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd,
      });
      if (generated.code !== 0) {
        throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
      }
      const text = readFileSync(out, "utf8");
      sql.set(mode, text);
      const lite = new PGlite();
      try {
        await lite.exec(SETUP);
        await lite.exec(MEMO_FUNCTIONS);
        await lite.exec(text);
        await lite.exec(SEED);
        const found: Record<string, readonly string[]> = {};
        for (const user of USERS) {
          for (const permission of PERMISSIONS) {
            await lite.exec("begin");
            await lite.query(
              "select set_config('request.jwt.claims', $1, true)",
              [CLAIMS(user)],
            );
            const rows = await lite.query<{ readonly id: string }>(
              "select d.id from public.doc d where permdock.permitted_doc_row(d, $1) order by d.id",
              [permission],
            );
            const ids = await lite.query<{ readonly id: string }>(
              "select t.id from permdock.permitted_tenant_ids($1) t(id) order by t.id",
              [permission],
            );
            await lite.exec("rollback");
            found[`${user}:${permission}:rows`] = rows.rows.map((r) => r.id);
            found[`${user}:${permission}:tenants`] = ids.rows.map((r) => r.id);
          }
        }
        answers.set(mode, found);
      } finally {
        await lite.close();
      }
    }
  }, 240_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls better_supabase.memo_get and memo_set for both memos only in that mode", () => {
    const own = sql.get("permdock") ?? "";
    const shared = sql.get("better-supabase") ?? "";
    expect(own).toContain("set_config(v_key");
    expect(own).not.toContain("better_supabase.memo_");
    expect(shared).toContain("better_supabase.memo_get(v_key)");
    expect(shared).toContain("better_supabase.memo_set(v_key");
    expect(shared).toContain("better_supabase.memo_get(v_permdock_key)");
    expect(shared).toContain("better_supabase.memo_set(v_permdock_key");
    expect(shared).toContain("'permdock.m.'");
  });

  it("returns the same rows and ids in both modes for every user and permission", () => {
    const own = answers.get("permdock") ?? {};
    expect(Object.keys(own)).toHaveLength(
      USERS.length * PERMISSIONS.length * 2,
    );
    expect(answers.get("better-supabase")).toStrictEqual(own);
  });
});
