import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
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

type Measured = {
  readonly users: readonly {
    readonly user: string;
    readonly token: boolean;
    readonly tenants: number;
    readonly shareKeys: number;
    readonly requests: number;
  }[];
  readonly shareKey: { readonly requests: number; readonly withKey: number };
  readonly pgStatStatements: string;
};

describe("rls measure", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([SETUP, ...(await rlsAndHook(FIXTURE))]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function measure(args: readonly string[]): Promise<Measured> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const uri = db.uri;
    const result = await run(
      ["rls", "measure", "--db-url-stdin", "--json", ...args],
      {
        cwd: FIXTURE,
        io: { stdout() {}, stderr() {}, readStdin: () => Promise.resolve(uri) },
      },
    );
    expect(result.code).toBe(0);
    const body: unknown = JSON.parse(result.stdout);
    const data =
      typeof body === "object" && body !== null && "data" in body
        ? body.data
        : body;
    // SAFETY: the command's `--json` data is the MeasureReport the test reads.
    return data as Measured;
  }

  it("counts the tenants of a user and the share keys their tokens allow", async () => {
    const report = await measure([
      "--as",
      `${OWNER},${VIEWER}`,
      "--requests",
      "3",
    ]);
    expect(report.users.map((user) => user.token)).toStrictEqual([true, true]);
    expect(report.users[0]).toMatchObject({
      user: OWNER,
      tenants: 1,
      shareKeys: 1,
      requests: 3,
    });
    expect(report.shareKey.requests).toBeGreaterThan(0);
    expect(report.shareKey.withKey).toBe(report.shareKey.requests);
  });

  it("reports a user the hook gives no token as tokenless", async () => {
    const report = await measure([
      "--as",
      "00000000-0000-4000-8000-0000000000ff",
    ]);
    expect(report.users[0]).toMatchObject({ token: false });
  });
});
