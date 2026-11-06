import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hookGenerate, rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/assignments-provider");

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000a2";
const C = "00000000-0000-4000-8000-0000000000a3";

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
insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.invitations (organization_id text, email text not null, role text not null);
create table public.job (id text primary key, "orgId" text not null);
`;

describe("the authorization version bumps once per statement", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-authz-ver-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const hookOut = join(dir, "hook.sql");
    const hook = await hookGenerate(["--out", hookOut], { cwd: FIXTURE });
    if (hook.code !== 0) {
      throw new Error(`hook generate: ${hook.stdout}${hook.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(readFileSync(hookOut, "utf8"));
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const db = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const versions = async (): Promise<Record<string, number>> => {
    const rows = (
      await db().query<{ readonly user_id: string; readonly version: number }>(
        "select user_id, version::int as version from permdock.permdock_authz_version order by user_id",
      )
    ).rows;
    return Object.fromEntries(rows.map((row) => [row.user_id, row.version]));
  };

  const reset = async (): Promise<void> => {
    await db().exec(
      "delete from public.organization_members; delete from permdock.permdock_authz_version;",
    );
  };

  it("replaces the row trigger with one trigger per event", async () => {
    const names = (
      await db().query<{ readonly tgname: string }>(
        "select tgname from pg_trigger where tgrelid = 'public.organization_members'::regclass and not tgisinternal order by 1",
      )
    ).rows.map((row) => row.tgname);
    expect(names).toContain("permdock_authz_version_insert");
    expect(names).toContain("permdock_authz_version_update");
    expect(names).toContain("permdock_authz_version_delete");
    expect(names).not.toContain("permdock_authz_version");
    const levels = (
      await db().query<{ readonly row_level: boolean }>(
        "select (tgtype & 1) = 1 as row_level from pg_trigger where tgname = 'permdock_authz_version_insert'",
      )
    ).rows;
    expect(levels[0]?.row_level).toBe(false);
  });

  it("bumps a user once for a statement that inserts several rows", async () => {
    await reset();
    await db().exec(
      `insert into public.organization_members values ('acme', '${A}', 'admin'), ('beta', '${A}', 'member'), ('acme', '${B}', 'member')`,
    );
    expect(await versions()).toStrictEqual({ [A]: 1, [B]: 1 });
  });

  it("bumps one user once for a 100-row insert, where a row trigger bumps 100 times", async () => {
    await reset();
    await db().exec(
      `insert into public.organization_members select 'org-' || n, '${A}', 'member' from generate_series(1, 100) n`,
    );
    expect(await versions()).toStrictEqual({ [A]: 1 });
  });

  it("bumps the old and the new user once when an update moves a membership", async () => {
    await reset();
    await db().exec(
      `insert into public.organization_members values ('acme', '${A}', 'admin')`,
    );
    await db().exec(
      `update public.organization_members set user_id = '${B}' where user_id = '${A}'`,
    );
    expect(await versions()).toStrictEqual({ [A]: 2, [B]: 1 });
  });

  it("bumps the user of every deleted row once and skips a deleted login", async () => {
    await reset();
    await db().exec(
      `insert into public.organization_members values ('acme', '${A}', 'admin'), ('beta', '${A}', 'member'), ('acme', '${C}', 'member')`,
    );
    await db().exec(
      `delete from public.organization_members where organization_id = 'acme'`,
    );
    expect(await versions()).toStrictEqual({ [A]: 2, [C]: 2 });
    await db().exec(`delete from auth.users where id = '${C}'`);
    expect(await versions()).toStrictEqual({ [A]: 2 });
    await db().exec(`insert into auth.users values ('${C}')`);
  });

  it("changes a role in place without bumping twice per row", async () => {
    await reset();
    await db().exec(
      `insert into public.organization_members values ('acme', '${A}', 'member'), ('beta', '${A}', 'member')`,
    );
    await db().exec(
      `update public.organization_members set role = 'admin' where user_id = '${A}'`,
    );
    expect(await versions()).toStrictEqual({ [A]: 2 });
  });
});
