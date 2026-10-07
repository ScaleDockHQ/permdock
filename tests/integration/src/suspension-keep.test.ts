import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import {
  type SqlQuery,
  fromJunction,
  subjectFromSupabase,
} from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { suspension } from "../fixtures/named-scopes/keep/permdock.config.ts";
import {
  assets,
  documents,
  permissions,
  policy,
} from "../fixtures/named-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/named-scopes/keep");

const OWNER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const PRIVATE = "00000000-0000-4000-8000-000000000003";
const VIEWER = "00000000-0000-4000-8000-000000000004";
const USERS = [OWNER, STAFF, PRIVATE, VIEWER];

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ""}'`).join(", ")})`)
    .join(", ");

// Organization B is suspended and keeps invoice.read; customer C sits inside it.
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
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(", ")};
create table organization_users (organization_id text not null, user_id uuid not null, role text not null, via text);
create table customer_contacts (
  customer_id text not null, organization_id text not null, user_id uuid not null, role text not null,
  via text, expires_at timestamptz
);
insert into organization_users values
  ('T', '${OWNER}', 'owner', 'staff'), ('B', '${OWNER}', 'owner', 'staff'),
  ('T', '${STAFF}', 'member', 'staff'), ('B', '${VIEWER}', 'viewer', 'staff');
insert into customer_contacts values
  ('A', 'T', '${PRIVATE}', 'contact', 'contact', null), ('C', 'B', '${STAFF}', 'contact', 'contact', null);
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', now());
create table customer (id text primary key, status text);
insert into customer values ('A', 'active'), ('G', 'archived'), ('C', 'active'), ('D', 'prospect');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
create table quote (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table invoice (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
insert into quote values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into invoice values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into asset values ${values(assets, ["id", "organization_id", "customer_id"])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;

type Claims = Record<string, unknown>;

async function generate(cwd: string): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-keep-"));
  const out = join(dir, "rls.sql");
  const hookOut = join(dir, "hook.sql");
  const rls = await run(
    ["rls", "generate", "--target", "sql", "--rbac", "supabase", "--out", out],
    { cwd },
  );
  if (rls.code !== 0) {
    throw new Error(`rls generate: ${rls.stdout}${rls.stderr}`);
  }
  const hook = await run(["supabase", "hook", "generate", "--out", hookOut], {
    cwd,
  });
  if (hook.code !== 0) {
    throw new Error(`hook generate: ${hook.stdout}${hook.stderr}`);
  }
  const sql = [readFileSync(out, "utf8"), readFileSync(hookOut, "utf8")];
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

describe.each([
  { mode: "jwt", cwd: FIXTURE },
  { mode: "database", cwd: join(FIXTURE, "database") },
])("suspension keep ($mode mode)", ({ cwd }) => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([SETUP, ...(await generate(cwd))]);
  }, 120_000);

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

  async function mint(user: string): Promise<Claims> {
    const event = JSON.stringify({
      user_id: user,
      claims: { sub: user, role: "authenticated", aal: "aal1" },
    });
    return as(
      "supabase_auth_admin",
      { role: "supabase_auth_admin" },
      async (client) => {
        const result = await client.query<{ event: { claims: Claims } }>(
          "select permdock.custom_access_token_hook($1::jsonb) as event",
          [event],
        );
        const claims = result.rows[0]?.event.claims;
        if (claims === undefined) {
          throw new Error("PermDock: the hook returned no claims");
        }
        return claims;
      },
    );
  }

  it("writes a membership of the suspended organization with the keys it keeps", async () => {
    expect((await mint(OWNER))["memberships"]).toEqual([
      {
        scope: "organization",
        id: "B",
        roles: ["owner"],
        via: "staff",
        keep: ["asset.read", "invoice.read"],
      },
      { scope: "organization", id: "T", roles: ["owner"], via: "staff" },
    ]);
    expect((await mint(STAFF))["memberships"]).toContainEqual({
      scope: "customer",
      id: "C",
      within: { organization: "B" },
      roles: ["contact"],
      via: "contact",
      keep: ["asset.read", "invoice.read"],
    });
  });

  it("reads the same memberships through the in-process source", async () => {
    const query: SqlQuery = (text, params) =>
      db!.admin.query(text, [...params]);
    const permdock = await createPermDock(
      policy,
      { id: OWNER, kind: "user" },
      {
        tenant: "B",
        memberships: [
          fromJunction({
            table: "organization_users",
            scope: "organization",
            id: "organization_id",
            roles: "role",
            via: "staff",
            suspension,
            query,
          }),
          fromJunction({
            table: "customer_contacts",
            scope: "customer",
            id: "customer_id",
            within: { organization: "organization_id" },
            roles: "role",
            via: "contact",
            expiresAt: "expires_at",
            suspension,
            query,
          }),
        ],
      },
    );
    expect(permdock.subject.principal?.memberships).toContainEqual({
      scope: "organization",
      id: "B",
      roles: ["owner"],
      via: "staff",
      keep: ["asset.read", "invoice.read"],
    });
    const inB = documents.find((row) => row.id === "d_c_sent");
    if (inB === undefined) {
      throw new Error("PermDock: the fixture lost d_c_sent");
    }
    expect(permdock.can(permissions.invoice.read, inB)).toBe(true);
    expect(permdock.can(permissions.quote.read, inB)).toBe(false);
  });

  it("agrees with subjectFromSupabase on the claims it minted, in either tenant", async () => {
    for (const user of USERS) {
      for (const tenant of ["T", "B"]) {
        const claims = { ...(await mint(user)), tenant_id: tenant };
        const principal = subjectFromSupabase(claims, {
          memberships: "memberships",
        }).principal;
        const permdock = await createPermDock(policy, principal);
        for (const [permission, table] of [
          [permissions.quote.read, "quote"],
          [permissions.invoice.read, "invoice"],
          [permissions.asset.read, "asset"],
        ] as const) {
          const rows = table === "asset" ? assets : documents;
          const expected = rows
            .filter((row) => permdock.can(permission, row))
            .map((row) => row.id)
            .toSorted();
          const actual = await as("authenticated", claims, async (client) =>
            (
              await client.query<{ id: string }>(
                `select id from public.${table} order by id`,
              )
            ).rows.map((row) => row.id),
          );
          expect({ user, tenant, table, rows: actual.toSorted() }).toEqual({
            user,
            tenant,
            table,
            rows: expected,
          });
          if (user === OWNER && tenant === "B") {
            expect(actual.length > 0).toBe(table !== "quote");
          }
        }
      }
    }
  });

  it("answers authorize() for a kept permission of a suspended tenant only", async () => {
    const authorize = async (
      permission: string,
      user: string,
      tenant = "B",
    ) => {
      const claims = { ...(await mint(user)), tenant_id: tenant };
      return as(
        "authenticated",
        claims,
        async (client) =>
          (
            await client.query<{ ok: boolean }>(
              `select permdock.authorize($1::permdock.app_permission, $2) as ok`,
              [permission, tenant],
            )
          ).rows[0]?.ok,
      );
    };
    expect(await authorize("asset.read", OWNER)).toBe(true);
    expect(await authorize("asset.delete", OWNER, "T")).toBe(true);
    expect(await authorize("asset.delete", OWNER)).toBe(false);
    expect(await authorize("asset.read", PRIVATE)).toBe(false);
  });
});
