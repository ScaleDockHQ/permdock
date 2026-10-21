import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { generateRls, jwtClaims } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/supabase-team-ids");

const MEMBER = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
insert into auth.users (id) values ('${MEMBER}'), ('${OTHER}');
create table organization_members (organization_id text not null, user_id uuid not null, role text not null);
insert into organization_members values ('acme', '${MEMBER}', 'member'), ('acme', '${OTHER}', 'member');
create table team_members (team_id text not null, organization_id text not null, user_id uuid not null);
insert into team_members values ('red', 'acme', '${MEMBER}'), ('blue', 'acme', '${OTHER}');
create table board (id text primary key, organization_id text not null, team_id text not null);
`;

describe("member_team_ids_of against Postgres", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([SETUP, await generateRls(FIXTURE)]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function teamsOf(caller: string, user: string): Promise<string[]> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const tester = db.tester;
    return db.as(
      { role: "authenticated", settings: jwtClaims(caller) },
      async () =>
        (
          await tester.query<{ id: string }>(
            "select id from permdock.member_team_ids_of($1::uuid) id order by id",
            [user],
          )
        ).rows.map((row) => row.id),
    );
  }

  it("lists the caller's own teams", async () => {
    expect(await teamsOf(MEMBER, MEMBER)).toStrictEqual(["red"]);
    expect(await teamsOf(OTHER, OTHER)).toStrictEqual(["blue"]);
  });

  it("lists nothing for another user", async () => {
    expect(await teamsOf(MEMBER, OTHER)).toStrictEqual([]);
  });

  it("denies anon", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const tester = db.tester;
    await expect(
      db.as({ role: "anon" }, () =>
        tester.query("select permdock.member_team_ids_of($1::uuid)", [MEMBER]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
