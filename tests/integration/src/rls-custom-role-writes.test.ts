import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/custom-role-writes");

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const MANAGER = "00000000-0000-4000-8000-0000000000b2";
const STEWARD = "00000000-0000-4000-8000-0000000000c3";

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
insert into auth.users (id) values ('${ADMIN}'), ('${MANAGER}'), ('${STEWARD}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MANAGER}', 'manager'),
  ('acme', '${STEWARD}', 'steward');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
`;

describe("permdock_replace_custom_role_grants with levels, renamed keys and manageRoles", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-custom-role-writes-"));

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const save = async (
    sub: string,
    role: string,
    allow: readonly string[],
  ): Promise<string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    try {
      await db.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub,
              role: "authenticated",
            }),
          },
        },
        async () => {
          await db?.tester.query(
            "select permdock.permdock_replace_custom_role_grants('acme', 'tenant', null, $1, $2, '{}', '{}')",
            [role, [...allow]],
          );
        },
      );
      return "ok";
    } catch (error) {
      return error instanceof DatabaseError
        ? `${error.code ?? ""} ${error.hint ?? ""}`
        : String(error);
    }
  };

  it("hands out only the levels the caller's own grants reach", async () => {
    expect(await save(MANAGER, "self-service", ["job.update@own"])).toBe("ok");
    expect(await save(MANAGER, "wide", ["job.update@all"])).toBe(
      "42501 not-assignable-by",
    );
    expect(await save(MANAGER, "wide", ["job.update"])).toBe(
      "42501 not-assignable-by",
    );
    expect(await save(MANAGER, "reader", ["job.read"])).toBe("ok");
    expect(await save(ADMIN, "wide", ["job.update"])).toBe("ok");
  });

  it("refuses a level the resource does not declare", async () => {
    expect(await save(ADMIN, "odd", ["job.read@team"])).toBe(
      "22023 unknown-level",
    );
  });

  it("lifts the hand-out check for a manageRoles holder, never the ceiling", async () => {
    expect(await save(STEWARD, "wide", ["job.update@all"])).toBe("ok");
    expect(await save(STEWARD, "wide", ["member.assignRole"])).toBe(
      "22023 outside-ceiling",
    );
  });

  it("stores an entry under a renamed key as the current key", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query("begin");
    try {
      await db.admin.query("set local role authenticated");
      await db.admin.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: ADMIN, role: "authenticated" })],
      );
      await db.admin.query(
        "select permdock.permdock_replace_custom_role_grants('acme', 'tenant', null, 'legacy', array['task.read'], array['task.read'], '{}')",
      );
      await db.admin.query("reset role");
      const rows = await db.admin.query<{ entry: string }>(
        "select effect || ':' || permission as entry from permdock.custom_role_permissions where role = 'legacy' order by 1",
      );
      expect(rows.rows.map((row) => row.entry)).toEqual([
        "allow:job.read",
        "deny:job.read",
      ]);
    } finally {
      await db.admin.query("rollback");
    }
  });
});
