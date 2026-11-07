import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hookGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/through-users");

const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
insert into auth.users (id) values ('${A}'), ('${B}');
create table public.contact_profiles (id text primary key, user_id uuid);
create table public.contact_roles (
  organization_id text not null,
  contact_profile_id text not null,
  role text not null
);
insert into public.contact_profiles values ('p1', '${A}'), ('p2', '${B}');
`;

describe("a membership whose user is read through a profile table", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-through-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const hookOut = join(dir, "hook.sql");
    const hook = await hookGenerate(["--out", hookOut], { cwd: FIXTURE });
    if (hook.code !== 0) {
      throw new Error(`hook generate: ${hook.stdout}${hook.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
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
      "delete from public.contact_roles; delete from permdock.permdock_authz_version;",
    );
  };

  it("uses statement triggers on the membership table", async () => {
    const rows = (
      await db().query<{
        readonly tgname: string;
        readonly row_level: boolean;
      }>(
        "select tgname, (tgtype & 1) = 1 as row_level from pg_trigger where tgrelid = 'public.contact_roles'::regclass and not tgisinternal order by 1",
      )
    ).rows;
    expect(rows.map((row) => row.tgname)).toStrictEqual([
      "permdock_authz_version_delete",
      "permdock_authz_version_insert",
      "permdock_authz_version_update",
    ]);
    expect(rows.every((row) => !row.row_level)).toBe(true);
  });

  it("bumps each referenced user once for a multi-row insert", async () => {
    await reset();
    await db().exec(
      "insert into public.contact_roles values ('acme', 'p1', 'a'), ('beta', 'p1', 'a'), ('acme', 'p2', 'a')",
    );
    expect(await versions()).toStrictEqual({ [A]: 1, [B]: 1 });
  });

  it("bumps the old and the new user when an update moves a membership, and on delete", async () => {
    await reset();
    await db().exec(
      "insert into public.contact_roles values ('acme', 'p1', 'a')",
    );
    await db().exec(
      "update public.contact_roles set contact_profile_id = 'p2' where contact_profile_id = 'p1'",
    );
    expect(await versions()).toStrictEqual({ [A]: 2, [B]: 1 });
    await db().exec("delete from public.contact_roles");
    expect(await versions()).toStrictEqual({ [A]: 2, [B]: 2 });
  });
});
