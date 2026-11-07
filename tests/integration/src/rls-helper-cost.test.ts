import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-memo");

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

type Proc = { name: string; procost: number; proparallel: string };

describe("generated helper cost and parallel safety", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-helper-cost-"));
  let lite: PGlite;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite.close();
  });

  async function procs(pattern: string): Promise<readonly Proc[]> {
    const { rows } = await lite.query<Proc>(
      `select p.proname as name, p.procost::int as procost, p.proparallel as proparallel
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'permdock' and p.proname ~ $1
       order by 1`,
      [pattern],
    );
    return rows;
  }

  it("costs the permitted id and row helpers at 1000", async () => {
    const found = await procs("^permitted_.*_(ids|rows|row)$");
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((proc) => [proc.name, proc.procost])).toStrictEqual(
      found.map((proc) => [proc.name, 1000]),
    );
  });

  it("leaves every helper that writes or calls a set_config memo parallel unsafe", async () => {
    const found = await procs("^permitted_.*(_ids|_ids_by_permission|_row)$");
    expect(found.map((proc) => [proc.name, proc.proparallel])).toStrictEqual(
      found.map((proc) => [proc.name, "u"]),
    );
  });
});
