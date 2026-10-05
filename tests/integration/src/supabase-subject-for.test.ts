import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { type SupabaseRpcClient, postgrestSources } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/named-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/subject-for");

const OWNER = "00000000-0000-4000-8000-0000000000d1";
const CONTACT = "00000000-0000-4000-8000-0000000000d2";
const SUSPENDED = "00000000-0000-4000-8000-0000000000d3";
const USERS = [OWNER, CONTACT, SUSPENDED];

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to supabase_auth_admin, authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(", ")};
create table memberships (
  user_id uuid not null, scope text not null, scope_id text not null, role text not null,
  via text, expires_at timestamptz, managed_by text, seats text[]
);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'B', 'mechanic', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff', null, null, null),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff', null, null, null);
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
insert into customer_contacts values ('A', 'T', '${CONTACT}');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null), ('X', now());
`;

async function generate(): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-subject-for-"));
  try {
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers,hook",
        "--out",
        join(dir, "{part}.sql"),
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return ["helpers.sql", "hook.sql"].map((file) =>
      readFileSync(join(dir, file), "utf8"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("subject_for and postgrestSources against Postgres", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      SETUP,
      ...(await generate()),
      `insert into permdock.user_roles values ('${OWNER}', 'platform-support');
select permdock.permdock_trusted_replace_custom_role_grants('B', 'organization', null, 'mechanic', array['asset.read'], array[]::text[], array[]::text[]);`,
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  /** A supabase-js shaped client over the superuser connection, as a `service_role` client would call it. */
  const client = (): SupabaseRpcClient => ({
    schema(name) {
      return {
        async rpc(fn, args) {
          if (db === undefined) {
            throw new Error("PermDock: Postgres was not started");
          }
          try {
            const result = await db.admin.query<{ data: unknown }>(
              `select "${name}"."${fn}"($1::uuid) as data`,
              [args["p_user"]],
            );
            return { data: result.rows[0]?.data ?? null, error: null };
          } catch (error) {
            return { data: null, error: { message: String(error) } };
          }
        },
      };
    },
  });

  it("returns what the hook would mint, with held custom roles", async () => {
    const sources = postgrestSources(client());
    const owner = await sources.record(OWNER);
    expect(owner).toMatchObject({
      id: OWNER,
      active: true,
      roles: ["platform-support"],
      authzVersion: 1,
    });
    expect(
      owner?.memberships.map((membership) => [membership.id, membership.roles]),
    ).toEqual([
      ["B", ["mechanic"]],
      ["T", ["owner"]],
    ]);
    expect(owner?.customRoles).toEqual([
      {
        name: "mechanic",
        tenant: "B",
        scope: "organization",
        grants: [{ permission: "asset.read", effect: "allow" }],
      },
    ]);
    const contact = await sources.record(CONTACT);
    expect(contact?.memberships).toEqual([
      {
        scope: "customer",
        id: "A",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
      },
    ]);
    expect(await sources.record(SUSPENDED)).toEqual({
      id: SUSPENDED,
      active: false,
      roles: [],
      memberships: [],
      customRoles: [],
    });
  });

  it("builds a PermDock for a stored user from the record", async () => {
    const sources = postgrestSources(client());
    const permdock = await createPermDock(
      policy,
      await sources.subject(OWNER),
      { customRoles: sources.customRoles({ id: OWNER }) },
    );
    const asset = { id: "a", organization_id: "B", customer_id: "c" };
    expect(permdock.tenant("B").can(permissions.asset.read, asset)).toBe(true);
    expect(permdock.tenant("B").can(permissions.asset.update, asset)).toBe(
      false,
    );
    expect((await sources.subject(SUSPENDED)).principal).toBeNull();
  });

  it("is not executable by client roles", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    await expect(
      target.as({ role: "authenticated" }, async () =>
        target.tester.query(`select permdock.subject_for('${OWNER}')`),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
