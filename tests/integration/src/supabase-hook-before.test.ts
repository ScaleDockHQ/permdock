import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/hook-before");

const VERIFIED = "00000000-0000-4000-8000-0000000000f1";
const BLOCKED = "00000000-0000-4000-8000-0000000000f2";
const BROKEN = "00000000-0000-4000-8000-0000000000f3";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant select on auth.users to supabase_auth_admin;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
insert into auth.users (id) values ('${VERIFIED}'), ('${BLOCKED}'), ('${BROKEN}');
create table organization_members (organization_id text not null, user_id uuid not null, role text not null);
insert into organization_members values ('acme', '${VERIFIED}', 'member'), ('acme', '${BLOCKED}', 'member');
create table project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table task (id text primary key, "orgId" text not null, "authorId" uuid not null, locked boolean not null default false);
create schema auth_checks;
create table auth_checks.blocked (user_id uuid primary key);
insert into auth_checks.blocked values ('${BLOCKED}');
grant usage on schema auth_checks to supabase_auth_admin;
grant select on auth_checks.blocked to supabase_auth_admin;
create function auth_checks.require_verified(event jsonb) returns jsonb language plpgsql stable as $$
begin
  if (event ->> 'user_id')::uuid = '${BROKEN}' then
    return null;
  end if;
  if exists (select 1 from auth_checks.blocked b where b.user_id = (event ->> 'user_id')::uuid) then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'blocked'));
  end if;
  return event;
end;
$$;
create function auth_checks.tag_event(event jsonb) returns jsonb language sql stable as $$
  select jsonb_set(event, '{claims,checked}', 'true'::jsonb)
$$;
revoke execute on function auth_checks.require_verified(jsonb) from public;
revoke execute on function auth_checks.tag_event(jsonb) from public;
`;

describe("supabase.hook.before", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-hook-before-"));
    const rlsOut = join(dir, "rls.sql");
    const hookOut = join(dir, "hook.sql");
    const rls = await run(
      ["rls", "generate", "--target", "sql", "--out", rlsOut],
      { cwd: FIXTURE },
    );
    if (rls.code !== 0) {
      throw new Error(`rls generate: ${rls.stdout}${rls.stderr}`);
    }
    const generated = await run(
      ["supabase", "hook", "generate", "--out", hookOut],
      {
        cwd: FIXTURE,
      },
    );
    if (generated.code !== 0) {
      throw new Error(`hook generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = [readFileSync(rlsOut, "utf8"), readFileSync(hookOut, "utf8")];
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, ...sql]);
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function mint(user: string): Promise<Record<string, unknown>> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    const event = JSON.stringify({
      user_id: user,
      claims: { sub: user, role: "authenticated" },
    });
    return db.as({ role: "supabase_auth_admin" }, async () => {
      const result = await client.query<{
        readonly event: Record<string, unknown>;
      }>("select permdock.custom_access_token_hook($1::jsonb) as event", [
        event,
      ]);
      return result.rows[0]?.event ?? {};
    });
  }

  it("runs the before functions first and keeps the event they return", async () => {
    const event = await mint(VERIFIED);
    expect(event["claims"]).toMatchObject({
      checked: true,
      memberships: [{ scope: "tenant", id: "acme", roles: ["member"] }],
    });
  });

  it("returns a before function's error without writing claims", async () => {
    expect(await mint(BLOCKED)).toEqual({
      error: { http_code: 403, message: "blocked" },
    });
  });

  it("refuses the token when a before function returns no event", async () => {
    expect(await mint(BROKEN)).toEqual({
      error: {
        http_code: 500,
        message: "auth_checks.require_verified returned no event",
      },
    });
  });
});
