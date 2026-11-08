import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { generated } from "./support/rls.ts";

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
create role service_role nologin;
grant authenticated, anon, supabase_auth_admin, service_role to tester;
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
  user_id uuid not null, scope text not null, scope_id text not null, role text,
  via text, expires_at timestamptz, managed_by text, seats text[]
);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'B', 'mechanic', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'N', null, 'staff', null, null, null),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff', null, null, null);
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
insert into customer_contacts values ('A', 'T', '${CONTACT}');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null), ('X', now());
`;

const SAVE = (tenant: string, role: string, allow: string) =>
  `select permdock.permdock_trusted_replace_custom_role_grants('${tenant}', 'organization', null, '${role}', ${allow}, array[]::text[], array[]::text[])`;

describe("compiled custom roles and the per-tenant version against Postgres", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      SETUP,
      ...(await generated(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--schemas",
          "migrations",
          "--split",
          "helpers,hook",
          "--out",
          "{dir}/{part}.sql",
        ],
        ["helpers.sql", "hook.sql"],
        { cwd: FIXTURE },
      )),
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  const target = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };
  const one = async (sql: string): Promise<unknown> =>
    Object.values((await target().admin.query(sql)).rows[0] ?? {})[0];

  it("compiles a saved role to one row holding the keys permdock_custom_keys returns", async () => {
    await target().admin.query(SAVE("B", "mechanic", "array['asset.read']"));
    const compiled = await one(
      "select grant_keys from permdock.custom_role_compiled where tenant_id = 'B' and role = 'mechanic'",
    );
    const resolved = await one(
      "select array_agg(k order by k) from permdock.permdock_custom_keys(array['asset.read'], array[]::text[], array[]::text[], 'organization') k",
    );
    expect(compiled).toStrictEqual(resolved);
    expect(compiled).not.toStrictEqual([]);
    expect(
      await one(
        "select grants from permdock.custom_role_compiled where tenant_id = 'B' and role = 'mechanic'",
      ),
    ).toStrictEqual([{ permission: "asset.read", effect: "allow" }]);
  });

  it("bumps one counter per tenant for one statement, however many rows it writes", async () => {
    const before = Number(
      (await one(
        "select coalesce((select version from permdock.custom_role_version where tenant_id = 'T'), 0)",
      )) ?? 0,
    );
    await target().admin.query(
      `insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
       select 'T', 'organization', null, 'crew' || n, 'asset.read', 'allow' from generate_series(1, 50) n`,
    );
    const after = Number(
      await one(
        "select version from permdock.custom_role_version where tenant_id = 'T'",
      ),
    );
    expect(after - before).toBe(1);
    expect(
      Number(
        await one(
          "select count(*) from permdock.custom_role_compiled where tenant_id = 'T'",
        ),
      ),
    ).toBe(50);
  });

  it("reads the tenant version through custom_roles_version_for, shared roles included", async () => {
    const tenant = Number(
      await one(
        "select version from permdock.custom_role_version where tenant_id = 'B'",
      ),
    );
    expect(
      Number(await one("select permdock.custom_roles_version_for('B')")),
    ).toBe(tenant);
    await target().admin.query(
      "insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect) values (null, 'organization', null, 'everyone', 'asset.read', 'allow')",
    );
    expect(
      Number(await one("select permdock.custom_roles_version_for('B')")),
    ).toBe(tenant + 1);
  });

  it("reports the tenant version of each held custom role in subject_for", async () => {
    await target().admin.query(SAVE("B", "mechanic", "array['asset.read']"));
    const subject = (await one(`select permdock.subject_for('${OWNER}')`)) as {
      customRolesVersions?: Record<string, number>;
    };
    expect(subject.customRolesVersions).toStrictEqual({
      B: Number(await one("select permdock.custom_roles_version_for('B')")),
    });
  });

  it("drops the compiled row when the role's last grant goes", async () => {
    await target().admin.query(SAVE("B", "mechanic", "array[]::text[]"));
    expect(
      Number(
        await one(
          "select count(*) from permdock.custom_role_compiled where tenant_id = 'B' and role = 'mechanic'",
        ),
      ),
    ).toBe(0);
  });

  it("reads no row of the source tables when a role is probed by the policies", async () => {
    await target().admin.query(SAVE("B", "mechanic", "array['asset.read']"));
    const plan = (
      await target().admin.query<{ "QUERY PLAN": string }>(
        "explain (analyze, costs off) select count(*) from permdock.permitted_organization_ids('asset.read')",
      )
    ).rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).not.toContain("permdock_custom_keys");
  });
});
