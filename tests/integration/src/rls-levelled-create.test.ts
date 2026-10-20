import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { jwtClaims } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ADMIN = "00000000-0000-4000-8000-0000000000e1";
const CREATOR = "00000000-0000-4000-8000-0000000000e2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
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
insert into auth.users (id) values ('${ADMIN}'), ('${CREATOR}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${CREATOR}', 'creator');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
grant select, insert on public.job to authenticated;
`;

const SEED = `insert into permdock.custom_role_permissions (tenant_id, scope, role, permission, effect)
values ('acme', 'tenant', 'creator', 'job.create@own', 'allow');
create policy job_insert_row_helper on public.job as restrictive for insert to authenticated
  with check (permdock.permitted_job_row(job, 'job.create'));`;

describe("a custom role holding an instance create at a level", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-levelled-create-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/levelled-create") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8"), SEED]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const as = async <T>(
    user: string,
    sql: string,
    values: readonly unknown[],
  ): Promise<T | string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    try {
      return await target.as(
        { role: "authenticated", settings: jwtClaims(user) },
        async () => {
          const result = await target.tester.query(sql, [...values]);
          // SAFETY: each caller selects one column of the type it names.
          return Object.values(result.rows[0] ?? {})[0] as T;
        },
      );
    } catch (error) {
      if (error instanceof DatabaseError) {
        return error.code ?? "";
      }
      throw error;
    }
  };

  const insert = (user: string, id: string, owner: string) =>
    as<undefined>(
      user,
      `insert into public.job (id, "orgId", "ownerId") values ($1, 'acme', $2)`,
      [id, owner],
    );

  it("inserts its own row and is refused another user's, with a hand-written row-helper policy beside the generated one", async () => {
    expect(await insert(CREATOR, "own", CREATOR)).toBeUndefined();
    expect(await insert(CREATOR, "theirs", ADMIN)).toBe("42501");
    expect(await insert(ADMIN, "admin", CREATOR)).toBeUndefined();
  });

  it("answers the same through permitted_job_row's create arm", async () => {
    const check = (owner: string) =>
      as<boolean>(
        CREATOR,
        `select permdock.permitted_job_row(row('j', 'acme', $1)::public.job, 'job.create')`,
        [owner],
      );
    expect(await check(CREATOR)).toBe(true);
    expect(await check(ADMIN)).toBe(false);
  });
});
