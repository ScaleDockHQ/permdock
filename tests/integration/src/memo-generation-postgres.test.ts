import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/assignments-provider");

const ADMIN = "00000000-0000-4000-8000-0000000000f2";

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
insert into auth.users (id) values ('${ADMIN}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values ('acme', '${ADMIN}', 'admin');
create table public.invitations (organization_id text, email text not null, role text not null);
create table public.job (id text primary key, "orgId" text not null);
insert into public.job values ('acme-job', 'acme');
`;

describe("RLS memo settings on Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-memo-postgres-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
    await db.admin.query(`
      create table permdock.permdock_authz_version (
        user_id uuid primary key references auth.users on delete cascade,
        version bigint not null default 0
      )
    `);
    await db.admin.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: ADMIN, role: "authenticated" }),
    ]);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("keeps the permdock.m settings bounded after 20,000 statements", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres did not start");
    }
    const key = await db.admin.query<{ readonly key: string }>(
      "select 'permdock.m.tenant.k' || (hashtext('job.read') & 1023)::text as key",
    );
    const name = key.rows[0]?.key;
    if (name === undefined) {
      throw new Error("PermDock: the memo key is missing");
    }
    const before = await db.admin.query<{ readonly bytes: number }>(
      "select total_bytes::int as bytes from pg_backend_memory_contexts where name = 'GUCMemoryContext'",
    );
    for (let index = 0; index < 20_000; index += 1) {
      await db.admin.query(
        "select array(select permdock.permitted_tenant_ids('job.read')) as ids",
      );
    }
    const shown = await db.admin.query<{ readonly n: number }>(
      "select count(*)::int as n from pg_show_all_settings() where name like 'permdock.m.%'",
    );
    const settings = await db.admin.query<{ readonly n: number }>(
      "select count(*)::int as n from pg_settings where name like 'permdock.m.%'",
    );
    const memo = await db.admin.query<{ readonly value: string }>(
      "select current_setting($1, true) as value",
      [name],
    );
    const after = await db.admin.query<{ readonly bytes: number }>(
      "select total_bytes::int as bytes from pg_backend_memory_contexts where name = 'GUCMemoryContext'",
    );
    expect(memo.rows[0]?.value).not.toBeNull();
    expect(
      Math.max(shown.rows[0]?.n ?? 0, settings.rows[0]?.n ?? 0),
    ).toBeLessThanOrEqual(4);
    expect(after.rows[0]?.bytes ?? 0).toBeLessThanOrEqual(
      (before.rows[0]?.bytes ?? 0) + 256 * 1024,
    );
  }, 120_000);
});
