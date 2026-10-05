import type { SqlQuery } from "permdock/supabase";
import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeMemberships, createPermDock, memoryRoleSource } from "permdock";
import { run } from "permdock/cli";
import { subjectFromSupabase } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { sources } from "../fixtures/centrakit-roles/sources.ts";
import { permissions, policy } from "../fixtures/centrakit/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/centrakit-roles");

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const PLATFORM = id(0xa1);
const OTHER = id(0xa2);
const OWNER = id(0xa3);
const DISPATCH_A = id(0xa4);
const DISPATCH_B = id(0xa5);
const SUSPENDED = id(0xa6);
const CONTACT = id(0xa7);
const CONTACT_2 = id(0xa8);
const LEAVER = id(0xa9);
const USERS = [
  PLATFORM,
  OTHER,
  OWNER,
  DISPATCH_A,
  DISPATCH_B,
  SUSPENDED,
  CONTACT,
  CONTACT_2,
  LEAVER,
];
const ORG_A = id(0xb1);
const ORG_B = id(0xb2);
const ORG_CLOSED = id(0xb3);
const CUST_A = id(0xc1);
const CUST_B = id(0xc2);
const CUST_CLOSED = id(0xc3);
const PROFILE = id(0xd1);
const PROFILE_UNLINKED = id(0xd2);
const PROFILE_LEAVER = id(0xd3);
const PLATFORM_ROLE = id(0xe1);
const SUPPORT_ROLE = id(0xe2);
const OWNER_ROLE = id(0xe3);
const ADMIN_ROLE = id(0xe4);
const MEMBER_ROLE = id(0xe5);
const VIEWER_ROLE = id(0xe6);
const DISPATCH_A_ROLE = id(0xe7);
const DISPATCH_B_ROLE = id(0xe8);

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
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((user) => `('${user}')`).join(", ")};
create table organizations (id uuid primary key, disabled_at timestamptz);
insert into organizations values ('${ORG_A}', null), ('${ORG_B}', null), ('${ORG_CLOSED}', now());
create table profiles (user_id uuid primary key, disabled_at timestamptz);
insert into profiles (user_id) select id from auth.users;
update profiles set disabled_at = now() where user_id = '${SUSPENDED}';
create type scope_type as enum ('system', 'organization', 'user', 'team');
create table roles (
  id uuid primary key,
  scope scope_type not null,
  key text not null,
  name text not null,
  system boolean not null default false,
  organization_id uuid references organizations (id) on delete cascade
);
create unique index roles_builtin_key on roles (scope, key) where organization_id is null;
create unique index roles_custom_key on roles (scope, key, organization_id);
alter table roles enable row level security;
insert into roles values
  ('${PLATFORM_ROLE}', 'system', 'platform-admin', 'Platform', true, null),
  ('${SUPPORT_ROLE}', 'system', 'support', 'Support', true, null),
  ('${OWNER_ROLE}', 'organization', 'owner', 'Owner', true, null),
  ('${ADMIN_ROLE}', 'organization', 'admin', 'Admin', true, null),
  ('${MEMBER_ROLE}', 'organization', 'member', 'Member', true, null),
  ('${VIEWER_ROLE}', 'organization', 'viewer', 'Viewer', true, null),
  ('${DISPATCH_A_ROLE}', 'organization', 'dispatcher', 'Dispatcher', false, '${ORG_A}'),
  ('${DISPATCH_B_ROLE}', 'organization', 'dispatcher', 'Dispatcher', false, '${ORG_B}');
create table user_roles (user_id uuid not null, role_id uuid not null references roles (id));
alter table user_roles enable row level security;
insert into user_roles values ('${PLATFORM}', '${PLATFORM_ROLE}'), ('${OTHER}', '${SUPPORT_ROLE}');
create table organization_users (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  role_id uuid not null references roles (id),
  unique (user_id, organization_id)
);
alter table organization_users enable row level security;
insert into organization_users values
  ('${OWNER}', '${ORG_A}', '${OWNER_ROLE}'),
  ('${OWNER}', '${ORG_B}', '${VIEWER_ROLE}'),
  ('${OWNER}', '${ORG_CLOSED}', '${ADMIN_ROLE}'),
  ('${DISPATCH_A}', '${ORG_A}', '${DISPATCH_A_ROLE}'),
  ('${DISPATCH_B}', '${ORG_B}', '${DISPATCH_B_ROLE}'),
  ('${SUSPENDED}', '${ORG_A}', '${ADMIN_ROLE}');
create table contact_profiles (
  id uuid primary key,
  user_id uuid unique references auth.users (id) on delete set null
);
alter table contact_profiles enable row level security;
insert into contact_profiles values
  ('${PROFILE}', '${CONTACT}'),
  ('${PROFILE_UNLINKED}', null),
  ('${PROFILE_LEAVER}', '${LEAVER}');
create table customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  customer_id uuid not null,
  contact_profile_id uuid not null references contact_profiles (id) on delete cascade
);
alter table customer_contacts enable row level security;
insert into customer_contacts (organization_id, customer_id, contact_profile_id) values
  ('${ORG_A}', '${CUST_A}', '${PROFILE}'),
  ('${ORG_CLOSED}', '${CUST_CLOSED}', '${PROFILE}'),
  ('${ORG_B}', '${CUST_B}', '${PROFILE_UNLINKED}'),
  ('${ORG_A}', '${CUST_A}', '${PROFILE_LEAVER}');
`;

type Claims = Record<string, unknown>;

async function generate(args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-roles-"));
  try {
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        ...args,
        "--out",
        join(dir, "{part}.sql"),
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const parts = args[args.indexOf("--split") + 1]?.split(",") ?? [];
    return parts
      .map((part) => readFileSync(join(dir, `${part}.sql`), "utf8"))
      .join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CentraKit user_roles and organization_users through roles.key", () => {
  let db: Postgres | undefined;
  let sql = "";
  let query: SqlQuery = async () => [];

  beforeAll(async () => {
    sql = await generate(["--split", "helpers,hook"]);
    const jwt = await generate([
      "--authorize",
      "jwt",
      "--rbac-schema",
      "permdock_jwt",
      "--split",
      "helpers",
    ]);
    db = await startPostgres([SETUP, sql, jwt]);
    const admin = db.admin;
    query = async (text, values) => (await admin.query(text, [...values])).rows;
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  function as<T>(
    role: "authenticated" | "supabase_auth_admin",
    claims: Claims,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    return db.as(
      { role, settings: { "request.jwt.claims": JSON.stringify(claims) } },
      () => work(client),
    );
  }

  const mint = (user: string) =>
    as("supabase_auth_admin", {}, async (client) => {
      const result = await client.query<{ event: { claims: Claims } }>(
        "select permdock.custom_access_token_hook($1::jsonb) as event",
        [JSON.stringify({ user_id: user, claims: { sub: user } })],
      );
      return result.rows[0]?.event.claims ?? {};
    });

  const has = (user: string, key: string) =>
    as("authenticated", { sub: user }, async (client) => {
      const result = await client.query<{ ok: boolean }>(
        "select permdock.permdock_has($1) as ok",
        [key],
      );
      return result.rows[0]?.ok;
    });

  const permitted = (schema: string, claims: Claims, key: string) =>
    as("authenticated", claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from ${schema}.permitted_organization_ids($1) as t(id) order by id`,
        [key],
      );
      return result.rows.map((row) => row.id);
    });

  const members = (
    schema: string,
    claims: Claims,
    scope: "organization" | "customer" = "organization",
  ) =>
    as("authenticated", claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from ${schema}.member_${scope}_ids() as t(id) order by id`,
      );
      return result.rows.map((row) => row.id);
    });

  const permittedCustomers = (schema: string, claims: Claims, key: string) =>
    as("authenticated", claims, async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from ${schema}.permitted_customer_ids($1) as t(id) order by id`,
        [key],
      );
      return result.rows.map((row) => row.id);
    });

  const portal = (customer: string, organization: string) => ({
    scope: "customer",
    id: customer,
    within: { organization },
    roles: ["contact"],
    via: "contact",
  });

  const version = async (user: string) => {
    const result = await db?.admin.query<{ version: string }>(
      "select version from permdock.permdock_authz_version where user_id = $1",
      [user],
    );
    return Number(result?.rows[0]?.version ?? 0);
  };

  it("reads both role tables through roles.key and creates no user_roles of its own", () => {
    expect(sql).toContain(
      'join "public"."roles" urk on urk."id" = ur."role_id"',
    );
    expect(sql).toContain('join "public"."roles" mk on mk."id" = m."role_id"');
    expect(sql).not.toMatch(/create table if not exists "public"\.user_roles/u);
  });

  it("mints the global and membership role keys and answers permdock_has from them", async () => {
    expect(await mint(PLATFORM)).toMatchObject({
      user_role: "platform-admin",
      roles: ["platform-admin"],
    });
    expect(await mint(OTHER)).toMatchObject({ roles: ["support"] });
    expect(await has(PLATFORM, "organizations.read")).toBe(true);
    expect(await has(OTHER, "organizations.read")).toBe(false);
    expect((await mint(OWNER))["memberships"]).toEqual(
      expect.arrayContaining([
        { scope: "organization", id: ORG_A, roles: ["owner"], via: "staff" },
        { scope: "organization", id: ORG_B, roles: ["viewer"], via: "staff" },
      ]),
    );
    expect((await mint(DISPATCH_B))["memberships"]).toEqual([
      { scope: "organization", id: ORG_B, roles: ["dispatcher"], via: "staff" },
    ]);
  });

  it("answers the database-mode helpers from roles.key", async () => {
    expect(
      await permitted("permdock", { sub: OWNER }, "customers.update"),
    ).toEqual([ORG_A]);
    expect(
      await permitted("permdock", { sub: OWNER }, "customers.read"),
    ).toEqual([ORG_A, ORG_B]);
    expect(await members("permdock", { sub: OWNER })).toEqual([ORG_A, ORG_B]);
    expect(
      await permitted("permdock", { sub: DISPATCH_A }, "customers.read"),
    ).toEqual([]);
  });

  it("answers the jwt-mode helpers from the claims the hook mints", async () => {
    const claims = await mint(OWNER);
    expect(await permitted("permdock_jwt", claims, "customers.update")).toEqual(
      [ORG_A],
    );
    expect(await members("permdock_jwt", claims)).toEqual([ORG_A, ORG_B]);
  });

  it("drops a suspended user and a suspended organization in the hook and both modes", async () => {
    expect(await mint(SUSPENDED)).toMatchObject({
      roles: [],
      memberships: [],
    });
    expect(
      await permitted("permdock", { sub: SUSPENDED }, "customers.read"),
    ).toEqual([]);
    expect(
      await permitted(
        "permdock_jwt",
        {
          sub: SUSPENDED,
          memberships: [
            {
              scope: "organization",
              id: ORG_A,
              roles: ["admin"],
              via: "staff",
            },
          ],
        },
        "customers.read",
      ),
    ).toEqual([]);
    expect(JSON.stringify((await mint(OWNER))["memberships"])).not.toContain(
      ORG_CLOSED,
    );
    expect(await members("permdock", { sub: OWNER })).not.toContain(ORG_CLOSED);
  });

  it("resolves a tenant's custom role key within that tenant at runtime", async () => {
    const customRoles = memoryRoleSource([
      {
        tenant: ORG_A,
        scope: "organization",
        name: "dispatcher",
        grants: [{ permission: "customers.read" }],
      },
      {
        tenant: ORG_B,
        scope: "organization",
        name: "dispatcher",
        grants: [{ permission: "quotes.read" }],
      },
    ]);
    const memberships = composeMemberships(sources(query));
    const dispatcher = async (user: string, tenant: string) =>
      createPermDock(
        policy,
        { id: user, tenant },
        { memberships, customRoles, tenant },
      );
    const a = await dispatcher(DISPATCH_A, ORG_A);
    const b = await dispatcher(DISPATCH_B, ORG_B);
    const customer = (organization: string) => ({
      id: CUST_A,
      organization_id: organization,
    });
    const quote = (organization: string) => ({
      id: id(0xf1),
      organization_id: organization,
      customer_id: CUST_A,
    });
    expect(a.can(permissions.customers.read, customer(ORG_A))).toBe(true);
    expect(a.can(permissions.quotes.read, quote(ORG_A))).toBe(false);
    expect(b.can(permissions.customers.read, customer(ORG_B))).toBe(false);
    expect(b.can(permissions.quotes.read, quote(ORG_B))).toBe(true);
    expect(b.can(permissions.quotes.read, quote(ORG_A))).toBe(false);
  });

  it("resolves the same memberships at runtime as the hook writes", async () => {
    const composed = composeMemberships(sources(query));
    for (const user of [OWNER, DISPATCH_A, CONTACT]) {
      const live = await composed.membershipsFor({ id: user }, {});
      const minted =
        subjectFromSupabase(await mint(user)).principal?.memberships ?? [];
      expect(live).toHaveLength(minted.length);
      expect(live).toEqual(expect.arrayContaining([...minted]));
    }
  });

  it("bumps every global and membership holder when a role key is renamed", async () => {
    const platform = await version(PLATFORM);
    const other = await version(OTHER);
    const owner = await version(OWNER);
    const dispatcher = await version(DISPATCH_A);
    await db?.admin.query(
      `update roles set name = 'Platform team' where id = $1`,
      [PLATFORM_ROLE],
    );
    expect(await version(PLATFORM)).toBe(platform);
    await db?.admin.query(
      `update roles set key = 'platform-operator' where id = $1`,
      [PLATFORM_ROLE],
    );
    expect(await version(PLATFORM)).toBe(platform + 1);
    expect(await version(OTHER)).toBe(other);
    expect(await has(PLATFORM, "organizations.read")).toBe(false);
    expect(await mint(PLATFORM)).toMatchObject({
      roles: ["platform-operator"],
    });
    await db?.admin.query(`update roles set key = 'principal' where id = $1`, [
      OWNER_ROLE,
    ]);
    expect(await version(OWNER)).toBe(owner + 1);
    expect(await version(DISPATCH_A)).toBe(dispatcher);
    expect(
      await permitted("permdock", { sub: OWNER }, "customers.update"),
    ).toEqual([]);
    expect((await mint(OWNER))["memberships"]).toEqual(
      expect.arrayContaining([
        {
          scope: "organization",
          id: ORG_A,
          roles: ["principal"],
          via: "staff",
        },
      ]),
    );
  });

  it("reads a portal contact's login through contact_profiles and lets supabase_auth_admin read it", async () => {
    expect(sql).toContain(
      'join "public"."contact_profiles" mu on mu."id" = m."contact_profile_id"',
    );
    expect(sql).toContain(
      'grant select on table "public"."contact_profiles" to supabase_auth_admin;',
    );
    expect((await mint(CONTACT))["memberships"]).toEqual([
      portal(CUST_A, ORG_A),
    ]);
    expect((await mint(CONTACT_2))["memberships"]).toEqual([]);
  });

  it("answers the customer helpers in both modes and drops a suspended organization's contacts", async () => {
    expect(await members("permdock", { sub: CONTACT }, "customer")).toEqual([
      CUST_A,
    ]);
    expect(
      await permittedCustomers("permdock", { sub: CONTACT }, "quotes.read"),
    ).toEqual([CUST_A]);
    const claims = await mint(CONTACT);
    expect(await members("permdock_jwt", claims, "customer")).toEqual([CUST_A]);
    expect(
      await permittedCustomers("permdock_jwt", claims, "quotes.read"),
    ).toEqual([CUST_A]);
    expect(
      await members(
        "permdock_jwt",
        {
          sub: CONTACT,
          memberships: [portal(CUST_A, ORG_A), portal(CUST_CLOSED, ORG_CLOSED)],
        },
        "customer",
      ),
    ).toEqual([CUST_A]);
    const composed = composeMemberships(sources(query));
    expect(await composed.membershipsFor({ id: CONTACT }, {})).toEqual([
      portal(CUST_A, ORG_A),
    ]);
  });

  it("holds no membership for a contact profile without a login", async () => {
    const contacts = sources(query)[1];
    expect(await contacts?.list?.({ scope: "customer", id: CUST_B })).toEqual(
      [],
    );
    expect(
      (await contacts?.list?.({ scope: "customer", id: CUST_A }))?.map(
        (entry) => entry.principal.id,
      ),
    ).toEqual([CONTACT, LEAVER].toSorted());
  });

  it("bumps the old and the new login when a contact profile is re-linked", async () => {
    const contact = await version(CONTACT);
    const second = await version(CONTACT_2);
    await db?.admin.query(
      `update contact_profiles set user_id = $1 where id = $2`,
      [CONTACT_2, PROFILE_UNLINKED],
    );
    expect(await version(CONTACT_2)).toBe(second + 1);
    expect(await version(CONTACT)).toBe(contact);
    expect((await mint(CONTACT_2))["memberships"]).toEqual([
      portal(CUST_B, ORG_B),
    ]);
    await db?.admin.query(
      `update contact_profiles set user_id = null where id = $1`,
      [PROFILE_UNLINKED],
    );
    await db?.admin.query(
      `update contact_profiles set user_id = $1 where id = $2`,
      [CONTACT_2, PROFILE],
    );
    expect(await version(CONTACT)).toBe(contact + 1);
    expect(await version(CONTACT_2)).toBe(second + 3);
    expect((await mint(CONTACT))["memberships"]).toEqual([]);
    expect((await mint(CONTACT_2))["memberships"]).toEqual([
      portal(CUST_A, ORG_A),
    ]);
    expect(await members("permdock", { sub: CONTACT }, "customer")).toEqual([]);
    await db?.admin.query(
      `insert into customer_contacts (organization_id, customer_id, contact_profile_id) values ($1, $2, $3)`,
      [ORG_B, CUST_B, PROFILE],
    );
    expect(await version(CONTACT_2)).toBe(second + 4);
    await db?.admin.query(
      `delete from customer_contacts where customer_id = $1 and contact_profile_id = $2`,
      [CUST_B, PROFILE],
    );
    expect(await version(CONTACT_2)).toBe(second + 5);
    expect(await version(CONTACT)).toBe(contact + 1);
  });

  it("deletes a login whose contact profile keeps its rows", async () => {
    await db?.admin.query(`delete from auth.users where id = $1`, [LEAVER]);
    const rows = await db?.admin.query(
      `select user_id from contact_profiles where id = $1`,
      [PROFILE_LEAVER],
    );
    expect(rows?.rows).toEqual([{ user_id: null }]);
  });
});
