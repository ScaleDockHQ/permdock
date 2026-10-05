import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ADMIN = "00000000-0000-4000-8000-0000000000c1";
const MANAGER = "00000000-0000-4000-8000-0000000000c2";

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
insert into auth.users (id) values ('${ADMIN}'), ('${MANAGER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('globex', '${ADMIN}', 'manager'),
  ('acme', '${MANAGER}', 'manager');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
`;

describe("permission-key helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-permission-keys-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/custom-role-writes") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const ids = async (user: string, sql: string): Promise<string[]> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    return target.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({
            sub: user,
            role: "authenticated",
          }),
        },
      },
      async () => {
        const result = await target.tester.query<{ id: string }>(sql);
        return result.rows.map((row) => row.id).toSorted();
      },
    );
  };

  it("answers with the unconditional allows of a permission key", async () => {
    const sql =
      "select id from permdock.permitted_tenant_ids_by_permission('job.update') id";
    expect(await ids(ADMIN, sql)).toEqual(["acme"]);
    expect(await ids(MANAGER, sql)).toEqual([]);
    const read =
      "select id from permdock.permitted_tenant_ids_by_permission('job.read') id";
    expect(await ids(ADMIN, read)).toEqual(["acme", "globex"]);
    expect(await ids(MANAGER, read)).toEqual(["acme"]);
  });

  it("maps a former key to the current one", async () => {
    expect(
      await ids(
        MANAGER,
        "select id from permdock.permitted_tenant_ids_by_permission('task.read') id",
      ),
    ).toEqual(["acme"]);
  });

  it("lists the grant keys and answers for a named user", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const keys = await db.admin.query<{ key: string }>(
      "select permdock.grant_keys('job.update', 'tenant') as key",
    );
    expect(keys.rows.map((row) => row.key)).toEqual([
      "job.update#1",
      "job.update#1@all",
    ]);
    const forUser = await db.admin.query<{ id: string }>(
      "select id from permdock.permitted_tenant_ids_by_permission_for($1, 'job.update') id",
      [ADMIN],
    );
    expect(forUser.rows.map((row) => row.id)).toEqual(["acme"]);
  });
});
