import type { SqlQuery } from "permdock/supabase";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { membership } from "../fixtures/supabase-role-sources/sources.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/supabase-role-sources");

const BOTH = "00000000-0000-4000-8000-0000000000c1";
const TIER = "00000000-0000-4000-8000-0000000000c2";
const NONE = "00000000-0000-4000-8000-0000000000c3";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant usage on schema auth to supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
insert into auth.users (id) values ('${BOTH}'), ('${TIER}'), ('${NONE}');
create table public.roles (id int primary key, key text not null unique);
insert into public.roles values (1, 'admin'), (2, 'viewer');
create table public.organization_users (organization_id text not null, user_id uuid not null, tier text, role_id int references public.roles (id));
insert into public.organization_users values
  ('T', '${BOTH}', 'member', 1),
  ('B', '${BOTH}', 'viewer', 2),
  ('T', '${TIER}', 'member', null),
  ('T', '${NONE}', null, null);
`;

describe("fromJunction with several role sources", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-role-sources-"));
    const out = join(dir, "hook.sql");
    const result = await run(["supabase", "hook", "generate", "--out", out], {
      cwd: FIXTURE,
    });
    if (result.code !== 0) {
      throw new Error(`hook generate: ${result.stdout}${result.stderr}`);
    }
    const generated = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function mint(user: string): Promise<unknown> {
    return db!.as({ role: "supabase_auth_admin" }, async () => {
      const result = await db!.tester.query<{
        event: { claims: Record<string, unknown> };
      }>("select permdock.custom_access_token_hook($1::jsonb) as event", [
        JSON.stringify({
          user_id: user,
          claims: { sub: user, role: "authenticated" },
        }),
      ]);
      return result.rows[0]?.event.claims["memberships"];
    });
  }

  it("writes the union of every non-null key, as the in-process source loads it", async () => {
    const query: SqlQuery = async (text, values) =>
      (await db!.admin.query(text, [...values])).rows;
    const source = membership(query);
    const byId = (list: readonly { readonly id?: string }[]) =>
      list.toSorted((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    const expected = {
      [BOTH]: [
        { scope: "organization", id: "B", roles: ["viewer"] },
        { scope: "organization", id: "T", roles: ["admin", "member"] },
      ],
      [TIER]: [{ scope: "organization", id: "T", roles: ["member"] }],
      [NONE]: [],
    };
    for (const [user, memberships] of Object.entries(expected)) {
      expect(await mint(user)).toEqual(memberships);
      expect(byId(await source.membershipsFor({ id: user }, {}))).toEqual(
        memberships,
      );
    }
  });

  it("bumps the authorization version of every holder when a role key changes", async () => {
    const version = async (user: string) =>
      (
        await db!.admin.query<{ readonly version: string }>(
          "select coalesce((select version from permdock.permdock_authz_version where user_id = $1), 0)::text as version",
          [user],
        )
      ).rows[0]?.version;
    const before = await version(BOTH);
    await db!.admin.query("update public.roles set key = 'owner' where id = 1");
    expect(Number(await version(BOTH))).toBeGreaterThan(Number(before));
    expect(await mint(BOTH)).toContainEqual({
      scope: "organization",
      id: "T",
      roles: ["member", "owner"],
    });
  });
});
