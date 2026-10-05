import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/rls-custom-roles");

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
`;

// What a schema diff that drops privileges and view options leaves behind.
const DIFFED = `
alter view permdock.permdock_ceiling reset (security_invoker);
grant usage on schema permdock to public;
grant execute on all functions in schema permdock to public;
`;

type Access = {
  readonly anonHas: boolean;
  readonly authenticatedHas: boolean;
  readonly authenticatedKeys: boolean;
  readonly authenticatedRows: boolean;
  readonly anonSchema: boolean;
  readonly invoker: boolean;
};

const ACCESS = `select
  has_function_privilege('anon', 'permdock.permdock_has(text)', 'execute') as "anonHas",
  has_function_privilege('authenticated', 'permdock.permdock_has(text)', 'execute') as "authenticatedHas",
  has_function_privilege('authenticated', 'permdock.permdock_custom_keys(text[], text[], text[], text)', 'execute') as "authenticatedKeys",
  has_table_privilege('authenticated', 'permdock.role_permissions', 'select') as "authenticatedRows",
  has_schema_privilege('anon', 'permdock', 'usage') as "anonSchema",
  coalesce('security_invoker=true' = any(c.reloptions), false) as invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'permdock' and c.relname = 'permdock_ceiling'`;

describe("rls generate --split helpers --grants-out", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-helper-grants-"));
  const out = join(dir, "{part}.sql");
  const grantsOut = join(dir, "grants.sql");

  beforeAll(async () => {
    const generated = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers",
        "--out",
        out,
        "--grants-out",
        grantsOut,
      ],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}`);
    }
    db = await startPostgres([
      SETUP,
      readFileSync(join(dir, "helpers.sql"), "utf8"),
      DIFFED,
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const access = async (): Promise<Access | undefined> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return (await db.admin.query<Access>(ACCESS)).rows[0];
  };

  it("restores the grants, revokes and view option a schema diff drops", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    expect(await access()).toEqual({
      anonHas: true,
      authenticatedHas: true,
      authenticatedKeys: true,
      authenticatedRows: false,
      anonSchema: true,
      invoker: false,
    });
    const grants = readFileSync(grantsOut, "utf8");
    expect(grants.split("\n", 1)[0]).toBe(
      "-- permdock:grants v1 schema=permdock",
    );
    await db.admin.query(grants);
    expect(await access()).toEqual({
      anonHas: false,
      authenticatedHas: true,
      authenticatedKeys: false,
      authenticatedRows: false,
      anonSchema: false,
      invoker: true,
    });
  });
});
