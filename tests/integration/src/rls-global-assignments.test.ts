import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const MEMBER = "00000000-0000-4000-8000-0000000000e2";
const NEWCOMER = "00000000-0000-4000-8000-0000000000e3";
const PLATFORM = "00000000-0000-4000-8000-0000000000e4";

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
insert into auth.users (id) values ('${OWNER}'), ('${MEMBER}'), ('${NEWCOMER}'), ('${PLATFORM}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.user_roles (
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${OWNER}', 'owner'),
  ('acme', '${MEMBER}', 'member');
insert into public.user_roles values ('${PLATFORM}', 'platform-admin');
create table public.job (id text primary key, "orgId" text not null);
grant select, insert, update, delete on public.organization_members, public.user_roles to authenticated;
`;

describe("rls.assignments on the global-roles table", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-global-assignments-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/global-assignments") },
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

  const as = async (user: string, sql: string): Promise<void> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    await target.as(
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
        await target.tester.query(sql);
      },
    );
  };

  const grant = (user: string, role: string): string =>
    `insert into public.user_roles values ('${user}', '${role}')`;

  it("refuses a client that grants itself a global role", async () => {
    await expect(as(MEMBER, grant(MEMBER, "platform-admin"))).rejects.toThrow(
      /may not change their own roles/u,
    );
    await expect(as(OWNER, grant(OWNER, "platform-support"))).rejects.toThrow(
      /may not change their own roles/u,
    );
  });

  it("refuses a global role the caller may not assign", async () => {
    await expect(
      as(OWNER, grant(NEWCOMER, "platform-support")),
    ).rejects.toThrow(/may not assign platform-support in null/u);
    await expect(
      as(PLATFORM, grant(NEWCOMER, "platform-admin")),
    ).rejects.toThrow(/may not assign platform-admin in null/u);
    await expect(as(PLATFORM, grant(NEWCOMER, "owner"))).rejects.toThrow(
      /may not assign owner in null/u,
    );
  });

  it("lets a client assign an assignable global role to another user", async () => {
    await expect(
      as(PLATFORM, grant(NEWCOMER, "platform-support")),
    ).resolves.toBeUndefined();
    await expect(
      as(
        PLATFORM,
        `delete from public.user_roles where user_id = '${NEWCOMER}'`,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a client write to its own row with ownRole: 'refuse'", async () => {
    await expect(
      as(PLATFORM, grant(PLATFORM, "platform-support")),
    ).rejects.toThrow(/may not change their own roles/u);
    await expect(
      as(
        PLATFORM,
        `delete from public.user_roles where user_id = '${PLATFORM}'`,
      ),
    ).rejects.toThrow(/may not change their own roles/u);
    await expect(
      as(
        OWNER,
        `update public.organization_members set role = 'member' where user_id = '${OWNER}'`,
      ),
    ).rejects.toThrow(/may not change their own roles/u);
    await expect(
      as(
        OWNER,
        `insert into public.organization_members values ('acme', '${NEWCOMER}', 'member')`,
      ),
    ).resolves.toBeUndefined();
  });

  it("trusts a write that is not a client role's", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(grant(PLATFORM, "platform-support"));
    const rows = await db.admin.query<{ role: string }>(
      `select role from public.user_roles where user_id = '${PLATFORM}' order by role`,
    );
    expect(rows.rows.map((row) => row.role)).toEqual([
      "platform-admin",
      "platform-support",
    ]);
  });
});
