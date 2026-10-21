import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { jwtClaims } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const GLOBAL = "00000000-0000-4000-8000-0000000000f1";
const TENANT = "00000000-0000-4000-8000-0000000000f2";

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
insert into auth.users (id) values ('${GLOBAL}'), ('${TENANT}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.app_roles (
  id integer primary key,
  organization_id text,
  name text not null
);
create table public.user_roles (
  user_id uuid not null references auth.users on delete cascade,
  role_id integer not null references public.app_roles
);
grant select on public.app_roles, public.user_roles to authenticated;
insert into public.app_roles values
  (1, null, 'support'),
  (2, 'acme', 'support'),
  (3, 'globex', 'support'),
  (4, 'acme', 'reviewer');
`;

describe("global roles through a roles table that also holds tenant roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-global-roles-through-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/global-roles-through") },
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

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const replace = (user: string, roles: string[]): string =>
    `select permdock.permdock_replace_global_roles('${user}', array[${roles.map((role) => `'${role}'`).join(", ")}]::text[])`;

  const roleIds = async (statements: readonly string[]): Promise<number[]> => {
    const admin = started().admin;
    await admin.query("begin");
    try {
      for (const statement of statements) {
        await admin.query(statement);
      }
      const rows = await admin.query<{ role_id: number }>(
        `select role_id from public.user_roles where user_id = '${GLOBAL}' order by role_id`,
      );
      return rows.rows.map((row) => row.role_id);
    } finally {
      await admin.query("rollback");
    }
  };

  it("inserts the one global row for a key that tenant roles share", async () => {
    await expect(
      roleIds([replace(GLOBAL, ["support"])]),
    ).resolves.toStrictEqual([1]);
    await expect(
      roleIds([replace(GLOBAL, ["support"]), replace(GLOBAL, ["support"])]),
    ).resolves.toStrictEqual([1]);
  });

  it("deletes a row that references a tenant role of the same key", async () => {
    await expect(
      roleIds([
        `insert into public.user_roles values ('${GLOBAL}', 2)`,
        replace(GLOBAL, ["support"]),
      ]),
    ).resolves.toStrictEqual([1]);
  });

  it("refuses a key only a tenant role has", async () => {
    await expect(roleIds([replace(GLOBAL, ["reviewer"])])).rejects.toThrow(
      /reviewer is not a role/u,
    );
  });

  it("reads a global role only from a row without a tenant", async () => {
    const target = started();
    await target.admin.query(
      `insert into public.user_roles values ('${GLOBAL}', 1), ('${TENANT}', 2)`,
    );
    const has = async (user: string): Promise<boolean> =>
      target.as(
        { role: "authenticated", settings: jwtClaims(user) },
        async () => {
          const rows = await target.tester.query<{ has: boolean }>(
            "select permdock.permdock_has('job.read') as has",
          );
          return rows.rows[0]?.has ?? false;
        },
      );
    expect(await has(GLOBAL)).toBe(true);
    expect(await has(TENANT)).toBe(false);
  });
});
