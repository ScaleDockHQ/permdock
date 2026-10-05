import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const OWNER = "00000000-0000-4000-8000-0000000000f1";
const ADMIN = "00000000-0000-4000-8000-0000000000f2";
const MEMBER = "00000000-0000-4000-8000-0000000000f3";
const NEWCOMER = "00000000-0000-4000-8000-0000000000f4";

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
insert into auth.users (id) values ('${OWNER}'), ('${ADMIN}'), ('${MEMBER}'), ('${NEWCOMER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${OWNER}', 'owner'),
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member');
create table public.invitations (organization_id text not null, email text not null, role text not null);
create table public.job (id text primary key, "orgId" text not null);
grant select, insert, update, delete on public.organization_members, public.invitations to authenticated;
`;

const SEED = `
select permdock.permdock_trusted_replace_custom_role_grants('acme', 'tenant', null, 'reader', array['job.read'], array[]::text[], array[]::text[]);
select permdock.permdock_trusted_replace_custom_role_grants('acme', 'tenant', null, 'editor', array['job.update'], array[]::text[], array[]::text[]);
`;

describe("rls.assignments", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-assignments-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/assignments") },
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

  const add = (role: string): string =>
    `insert into public.organization_members values ('acme', '${NEWCOMER}', '${role}')`;

  it("lets a caller assign what its roles' assigns list", async () => {
    await expect(as(ADMIN, add("member"))).resolves.toBeUndefined();
    await expect(as(OWNER, add("admin"))).resolves.toBeUndefined();
  });

  it("refuses a role the caller may not assign, and removing or changing one", async () => {
    await expect(as(ADMIN, add("admin"))).rejects.toThrow(
      /may not assign admin in acme/u,
    );
    await expect(as(MEMBER, add("member"))).rejects.toThrow(
      /may not assign member in acme/u,
    );
    await expect(
      as(
        ADMIN,
        `delete from public.organization_members where user_id = '${OWNER}'`,
      ),
    ).rejects.toThrow(/may not assign owner/u);
    await expect(
      as(
        ADMIN,
        `update public.organization_members set role = 'member' where user_id = '${OWNER}'`,
      ),
    ).rejects.toThrow(/may not assign owner/u);
  });

  it("assigns a custom role only within what the caller may hand out", async () => {
    await expect(as(ADMIN, add("reader"))).resolves.toBeUndefined();
    await expect(as(ADMIN, add("editor"))).rejects.toThrow(
      /may not assign editor/u,
    );
    await expect(as(OWNER, add("editor"))).resolves.toBeUndefined();
    await expect(as(ADMIN, add("nobody"))).rejects.toThrow(
      /may not assign nobody/u,
    );
  });

  it("checks the extra tables and trusts a write that is not a client role's", async () => {
    await expect(
      as(
        ADMIN,
        "insert into public.invitations values ('acme', 'a@example.com', 'admin')",
      ),
    ).rejects.toThrow(/may not assign admin/u);
    await expect(
      as(
        ADMIN,
        "insert into public.invitations values ('acme', 'a@example.com', 'member')",
      ),
    ).resolves.toBeUndefined();
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(add("owner"));
    const rows = await db.admin.query<{ role: string }>(
      `select role from public.organization_members where user_id = '${NEWCOMER}'`,
    );
    expect(rows.rows.map((row) => row.role)).toEqual(["owner"]);
  });
});
