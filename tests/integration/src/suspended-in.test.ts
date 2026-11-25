import type { Client } from "pg";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandMemberships } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { assets, documents } from "../fixtures/named-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";
import { rlsAndHook } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/named-scopes/suspended-in");

const OWNER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const PRIVATE = "00000000-0000-4000-8000-000000000003";
const VIEWER = "00000000-0000-4000-8000-000000000004";
const USERS = [OWNER, STAFF, PRIVATE, VIEWER];

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ""}'`).join(", ")})`)
    .join(", ");

// Organization B is suspended without keep; customer C sits inside it.
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

describe("suspended_in", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([SETUP, ...(await rlsAndHook(FIXTURE))]);
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

  function mint(user: string): Promise<Claims> {
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

  function subjectOf(user: string, tenant?: string): Promise<unknown> {
    return as(
      "authenticated",
      { sub: user, role: "authenticated" },
      async (client) => {
        const result =
          tenant === undefined
            ? await client.query<{ subject: unknown }>(
                "select permdock.permdock_subject() as subject",
              )
            : await client.query<{ subject: unknown }>(
                "select permdock.permdock_subject($1::text) as subject",
                [tenant],
              );
        return result.rows[0]?.subject ?? null;
      },
    );
  }

  it("lists the suspended tenant of a member and keeps its entry out of memberships", async () => {
    const claims = await mint(OWNER);
    expect(claims["suspended_in"]).toStrictEqual(["B"]);
    expect(expandMemberships(claims["memberships"])).toStrictEqual([
      { scope: "organization", id: "T", roles: ["owner"], via: "staff" },
    ]);
  });

  it("lists the tenant of a contact whose customer sits in it", async () => {
    expect((await mint(STAFF))["suspended_in"]).toStrictEqual(["B"]);
  });

  it("lists it for a user whose only membership is in the suspended tenant", async () => {
    const claims = await mint(VIEWER);
    expect(claims["suspended_in"]).toStrictEqual(["B"]);
    expect(expandMemberships(claims["memberships"])).toStrictEqual([]);
  });

  it("writes no claim for a user with no suspended tenant", async () => {
    expect(await mint(PRIVATE)).not.toHaveProperty("suspended_in");
  });

  it("returns suspendedIn from permdock_subject() and tells a suspension from no membership", async () => {
    const all = await subjectOf(OWNER);
    expect(all).toMatchObject({ suspendedIn: ["B"] });
    const inB = await subjectOf(VIEWER, "B");
    expect(inB).toMatchObject({ suspendedIn: ["B"], memberships: [] });
    expect(await subjectOf(PRIVATE, "B")).toBeNull();
    expect(await subjectOf(VIEWER, "T")).toBeNull();
  });
});
