import type { SupabaseRpcClient } from "permdock/supabase";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memorySubjectCache } from "permdock";
import { postgrestSources } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { generated, jwtClaims } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/subject-for");

const OWNER = "00000000-0000-4000-8000-0000000000d1";
const CONTACT = "00000000-0000-4000-8000-0000000000d2";
const SUSPENDED = "00000000-0000-4000-8000-0000000000d3";
const CREW = "00000000-0000-4000-8000-0000000000d4";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const USERS = [OWNER, CONTACT, SUSPENDED, CREW];

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
insert into memberships values
  ('${CREW}', 'organization', 'T', 'crew', 'staff', null, null, null),
  ('${CREW}', 'organization', 'B', 'crew', 'staff', null, null, null),
  ('${CREW}', 'organization', 'T', 'everyone', 'staff', null, null, null),
  ('${CREW}', 'organization', 'B', 'everyone', 'staff', null, null, null);
`;

const SAVE = (tenant: string, role: string, allow: string) =>
  `select permdock.permdock_trusted_replace_custom_role_grants('${tenant}', 'organization', null, '${role}', ${allow}, array[]::text[], array[]::text[])`;

type Entry = { id: string; roles?: string[]; within?: Record<string, string> };
type Subject = {
  id: string;
  active?: boolean;
  roles?: string[];
  memberships?: Entry[];
  customRoles?: {
    name: string;
    shared?: boolean;
    tenant?: string;
    scope: string;
  }[];
  customRolesVersions?: Record<string, number>;
  authzVersion?: number;
};

describe("subject_for(p_user, p_tenant) against Postgres", () => {
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
      `insert into permdock.user_roles values ('${OWNER}', 'platform-support');
${SAVE("B", "mechanic", "array['asset.read']")};
${SAVE("T", "crew", "array['asset.read']")};
${SAVE("B", "crew", "array['asset.update']")};
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect) values (null, 'organization', null, 'everyone', 'asset.read', 'allow')`,
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
  const one = async (user: string): Promise<Subject | null> =>
    (
      await target().admin.query<{ s: Subject | null }>(
        "select permdock.subject_for($1::uuid) as s",
        [user],
      )
    ).rows[0]?.s ?? null;
  const forTenant = async (
    user: string,
    tenant: string | null,
  ): Promise<Subject | null> =>
    (
      await target().admin.query<{ s: Subject | null }>(
        "select permdock.subject_for($1::uuid, $2::text) as s",
        [user, tenant],
      )
    ).rows[0]?.s ?? null;
  const tenantOf = (entry: Entry): string | undefined =>
    entry.within?.["organization"] ?? entry.id;

  /** The one-argument subject cut down to one tenant, by the spec of the issue. */
  const restricted = (
    subject: Subject | null,
    tenant: string,
  ): Subject | null => {
    if (subject === null || subject.active === false) {
      return subject;
    }
    const memberships = (subject.memberships ?? []).filter(
      (entry) => tenantOf(entry) === tenant,
    );
    const held = new Set(memberships.flatMap((entry) => entry.roles ?? []));
    const customRoles = (subject.customRoles ?? []).filter(
      (role) =>
        role.scope === "global" ||
        (held.has(role.name) &&
          (role.shared === true || role.tenant === tenant)),
    );
    const versions = Object.fromEntries(
      Object.entries(subject.customRolesVersions ?? {}).filter(
        ([key]) => key === tenant,
      ),
    );
    const { customRolesVersions: _drop, ...rest } = subject;
    return {
      ...rest,
      memberships,
      customRoles,
      ...(Object.keys(versions).length === 0
        ? {}
        : { customRolesVersions: versions }),
    };
  };

  it("equals subject_for(p_user) cut down to the tenant, for every user and tenant", async () => {
    for (const user of [...USERS, UNKNOWN]) {
      const full = await one(user);
      for (const tenant of ["T", "B", "X", "N", "Z"]) {
        const got = await forTenant(user, tenant);
        const want = restricted(full, tenant);
        // A custom-role version is read only for held custom roles of the tenant.
        if (got?.customRolesVersions !== undefined && want !== null) {
          expect(got.customRolesVersions).toStrictEqual(
            want.customRolesVersions ?? got.customRolesVersions,
          );
        }
        const { customRolesVersions: _a, ...gotRest } = got ?? { id: "" };
        const { customRolesVersions: _b, ...wantRest } = want ?? { id: "" };
        expect([user, tenant, got === null ? null : gotRest]).toStrictEqual([
          user,
          tenant,
          want === null ? null : wantRest,
        ]);
      }
    }
  });

  it("returns the memberships of one tenant and never another's", async () => {
    const t = await forTenant(OWNER, "T");
    expect(t?.memberships?.map((entry) => entry.id)).toStrictEqual(["T"]);
    const b = await forTenant(OWNER, "B");
    expect(b?.memberships?.map((entry) => entry.id)).toStrictEqual(["B"]);
    expect(t?.roles).toStrictEqual(["platform-support"]);
    expect(b?.roles).toStrictEqual(["platform-support"]);
    const contact = await forTenant(CONTACT, "T");
    expect(contact?.memberships).toStrictEqual([
      {
        scope: "customer",
        id: "A",
        within: { organization: "T" },
        roles: ["contact"],
        via: "contact",
      },
    ]);
  });

  it("fails closed for an unknown tenant, a tenant with no membership, a suspended tenant and a null tenant", async () => {
    for (const tenant of ["Z", "X", "N", null]) {
      const subject = await forTenant(OWNER, tenant);
      expect([tenant, subject?.memberships]).toStrictEqual([tenant, []]);
      expect(subject?.customRoles).toStrictEqual([]);
    }
    expect((await forTenant(CONTACT, "B"))?.memberships).toStrictEqual([]);
    expect((await forTenant(CONTACT, "B"))?.id).toBe(CONTACT);
  });

  it("honours a suspended user and an unknown user", async () => {
    expect(await forTenant(SUSPENDED, "T")).toStrictEqual({
      id: SUSPENDED,
      active: false,
    });
    expect(await forTenant(SUSPENDED, "T")).toStrictEqual(await one(SUSPENDED));
    expect(await forTenant(UNKNOWN, "T")).toBeNull();
  });

  it("pins tenant custom roles to the tenant and carries shared roles", async () => {
    const t = await forTenant(CREW, "T");
    const b = await forTenant(CREW, "B");
    expect(
      t?.customRoles?.map((role) => [role.name, role.tenant, role.shared]),
    ).toStrictEqual([
      ["crew", "T", undefined],
      ["everyone", undefined, true],
    ]);
    expect(
      b?.customRoles?.map((role) => [role.name, role.tenant, role.shared]),
    ).toStrictEqual([
      ["crew", "B", undefined],
      ["everyone", undefined, true],
    ]);
    expect(JSON.stringify(t?.customRoles)).toContain("asset.read");
    expect(JSON.stringify(b?.customRoles)).toContain("asset.update");
    expect(Object.keys(t?.customRolesVersions ?? {})).toStrictEqual(["T"]);
    expect(Object.keys(b?.customRolesVersions ?? {})).toStrictEqual(["B"]);
    const owner = await forTenant(OWNER, "B");
    expect(owner?.customRoles?.map((role) => role.name)).toStrictEqual([
      "mechanic",
    ]);
    expect((await forTenant(OWNER, "T"))?.customRoles).toStrictEqual([]);
  });

  it("is executable by no client role, and the memberships reader with it", async () => {
    const pg = target();
    for (const sql of [
      `select permdock.subject_for('${OWNER}'::uuid, 'T'::text)`,
      `select * from permdock.memberships_for('${OWNER}'::uuid, 'T')`,
    ]) {
      for (const role of ["authenticated", "anon"]) {
        await expect(
          pg.as({ role, settings: jwtClaims(OWNER) }, async () =>
            pg.tester.query(sql),
          ),
        ).rejects.toThrow(/permission denied/u);
      }
    }
  });

  it("pins the search path and never mentions service_role", async () => {
    const { rows } = await target().admin.query<{
      config: string[] | null;
      definer: boolean;
      src: string;
    }>(
      `select p.proconfig as config, p.prosecdef as definer, p.prosrc as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'permdock' and p.proname = 'subject_for' and p.pronargs = 2`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definer).toBe(true);
    expect(rows[0]?.config).toStrictEqual(['search_path=""']);
    expect(rows[0]?.src).not.toContain("service_role");
  });

  it("loads one tenant's memberships through postgrestSources({ tenantScoped })", async () => {
    const pg = target();
    const client: SupabaseRpcClient = {
      schema: (schema) => ({
        async rpc(fn, args) {
          const names = Object.keys(args);
          const list = names.map((name, at) => `${name} => $${at + 1}`);
          try {
            const { rows } = await pg.admin.query<{ data: unknown }>(
              `select ${schema}.${fn}(${list.join(", ")}) as data`,
              names.map((name) => args[name]),
            );
            return { data: rows[0]?.data ?? null, error: null };
          } catch (error) {
            return {
              data: null,
              error: { message: error instanceof Error ? error.message : "" },
            };
          }
        },
      }),
    };
    const sources = postgrestSources(client, {
      tenantScoped: true,
      subjects: memorySubjectCache(),
    });
    const ids = async (tenant: string): Promise<(string | undefined)[]> =>
      (await sources.memberships.membershipsFor({ id: OWNER }, { tenant })).map(
        (membership) => membership.id,
      );
    expect(await ids("T")).toStrictEqual(["T"]);
    expect(await ids("B")).toStrictEqual(["B"]);
    expect(await ids("Z")).toStrictEqual([]);
    expect(
      await sources.memberships.membershipsFor({ id: OWNER }, {}),
    ).toStrictEqual([]);
    const all = postgrestSources(client);
    expect(
      (await all.memberships.membershipsFor({ id: OWNER }, { tenant: "T" }))
        .length,
    ).toBeGreaterThan(1);
    const crew = await sources.customRoles({ id: CREW }).rolesFor?.("B");
    expect(crew?.map((role) => role.name)).toStrictEqual(["crew"]);
  });
});
