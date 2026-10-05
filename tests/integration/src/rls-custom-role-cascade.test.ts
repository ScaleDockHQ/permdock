import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ADMIN = "00000000-0000-4000-8000-0000000000e1";
const OUTSIDER = "00000000-0000-4000-8000-0000000000e2";

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
insert into auth.users (id) values ('${ADMIN}'), ('${OUTSIDER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('globex', '${ADMIN}', 'admin'),
  ('globex', '${OUTSIDER}', 'admin');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.app_roles (
  id serial primary key,
  organization_id text,
  name text not null,
  builtin boolean not null default false
);
grant select, update, delete on public.app_roles to authenticated;
`;

const SEED = `
insert into public.app_roles (organization_id, name, builtin) values
  ('acme', 'reviewer', false),
  ('acme', 'admin', true);
select permdock.permdock_trusted_replace_custom_role_grants('acme', 'tenant', null, 'reviewer', array['job.read'], array[]::text[], array[]::text[]);
`;

describe("rls.customRoleWrites.roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-custom-role-cascade-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/custom-role-cascade") },
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

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const grants = async (): Promise<string[]> =>
    (
      await started().admin.query<{ row: string }>(
        "select tenant_id || '/' || scope || '/' || role || '/' || permission as row from permdock.custom_role_permissions order by 1",
      )
    ).rows.map((row) => row.row);

  /** Runs `sql` as the signed-in `user` and returns the grants inside that transaction, which then rolls back. */
  const as = async (user: string, sql: string): Promise<string[]> => {
    const admin = started().admin;
    await admin.query("begin");
    try {
      await admin.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated" }),
      ]);
      await admin.query("set local role authenticated");
      await admin.query(sql);
      await admin.query("reset role");
      return await grants();
    } finally {
      await admin.query("rollback");
    }
  };

  it("moves the grants with a trusted rename and back", async () => {
    const admin = started().admin;
    await admin.query(
      "update public.app_roles set name = 'auditor' where name = 'reviewer'",
    );
    expect(await grants()).toEqual(["acme/tenant/auditor/job.read"]);
    await admin.query(
      "update public.app_roles set name = 'reviewer' where name = 'auditor'",
    );
    expect(await grants()).toEqual(["acme/tenant/reviewer/job.read"]);
  });

  it("checks a signed-in caller the way the write functions do", async () => {
    await expect(
      as(
        OUTSIDER,
        "update public.app_roles set name = 'auditor' where name = 'reviewer'",
      ),
    ).rejects.toThrow(/not a member of acme/u);
    await expect(
      as(
        ADMIN,
        "update public.app_roles set organization_id = 'initech' where name = 'reviewer'",
      ),
    ).rejects.toThrow(/not a member of initech/u);
    expect(
      await as(
        ADMIN,
        "update public.app_roles set name = 'auditor' where name = 'reviewer'",
      ),
    ).toEqual(["acme/tenant/auditor/job.read"]);
    expect(await grants()).toEqual(["acme/tenant/reviewer/job.read"]);
  });

  it("skips rows the skip column marks and deletes the grants with the row", async () => {
    const admin = started().admin;
    await admin.query(
      "update public.app_roles set name = 'owner' where name = 'admin'",
    );
    expect(await grants()).toEqual(["acme/tenant/reviewer/job.read"]);
    await admin.query("delete from public.app_roles where name = 'reviewer'");
    expect(await grants()).toEqual([]);
  });
});
