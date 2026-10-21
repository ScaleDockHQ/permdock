import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/hook-teams");

const MEMBER = "00000000-0000-4000-8000-0000000000a1";
const CROWDED = "00000000-0000-4000-8000-0000000000a2";
const SUSPENDED = "00000000-0000-4000-8000-0000000000a3";
const TEAM = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
insert into auth.users (id) values ('${MEMBER}'), ('${CROWDED}'), ('${SUSPENDED}');
create table organization_members (organization_id text not null, user_id uuid not null, role text not null);
insert into organization_members values ('acme', '${MEMBER}', 'member'), ('acme', '${CROWDED}', 'member');
create table team_members (team_id uuid not null, organization_id text not null, user_id uuid not null);
grant select on team_members to supabase_auth_admin;
insert into team_members values
  ('${TEAM(2)}', 'other', '${MEMBER}'),
  ('${TEAM(1)}', 'acme', '${MEMBER}');
insert into team_members select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'acme', '${CROWDED}' from generate_series(10, 40) g;
create table project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table task (id text primary key, "orgId" text not null, "authorId" uuid not null, locked boolean not null default false);
`;

describe("supabase.hook.teams", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-hook-teams-"));
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
      { cwd: FIXTURE },
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

  async function mint(
    user: string,
    claims: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    const event = JSON.stringify({
      user_id: user,
      claims: { sub: user, role: "authenticated", ...claims },
    });
    return db.as({ role: "supabase_auth_admin" }, async () => {
      const result = await client.query<{
        readonly event: { readonly claims: Record<string, unknown> };
      }>("select permdock.custom_access_token_hook($1::jsonb) as event", [
        event,
      ]);
      return result.rows[0]?.event.claims ?? {};
    });
  }

  it("writes team_ids with the active tenant's teams first", async () => {
    const claims = await mint(MEMBER, {
      app_metadata: { active_tenant: "acme" },
    });
    expect(claims["team_ids"]).toStrictEqual([TEAM(1), TEAM(2)]);
    expect(claims["memberships_truncated"]).toBeUndefined();
  });

  it("cuts team_ids at the memberships budget and flags the truncation", async () => {
    const claims = await mint(CROWDED, {
      app_metadata: { active_tenant: "acme" },
    });
    const teams = claims["team_ids"];
    if (!Array.isArray(teams)) {
      throw new TypeError("team_ids is not an array");
    }
    expect(teams.length).toBeLessThan(31);
    expect(
      JSON.stringify(claims["memberships"]).length +
        JSON.stringify(teams).length,
    ).toBeLessThanOrEqual(400);
    expect(claims["memberships_truncated"]).toBe(true);
  });

  it("returns every team in subject_for's claims, with no budget", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const record = await db.admin.query<{
      readonly subject: { readonly claims?: { readonly team_ids?: string[] } };
    }>(`select permdock.subject_for('${CROWDED}') as subject`);
    expect(record.rows[0]?.subject.claims?.team_ids).toHaveLength(31);
    const none = await db.admin.query<{
      readonly subject: { readonly claims?: unknown };
    }>(`select permdock.subject_for('${SUSPENDED}') as subject`);
    expect(none.rows[0]?.subject.claims).toBeUndefined();
  });

  it("writes no team_ids for a user in no team", async () => {
    expect((await mint(SUSPENDED))["team_ids"]).toBeUndefined();
  });
});
