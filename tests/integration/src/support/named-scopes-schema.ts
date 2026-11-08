import { assets, documents } from "../../fixtures/named-scopes/policy.ts";

/** The `named-scopes` fixture's users and tables, as `authenticated` sees them. */
export const OWNER = "00000000-0000-4000-8000-000000000001";
export const STAFF = "00000000-0000-4000-8000-000000000002";
export const PRIVATE = "00000000-0000-4000-8000-000000000003";
export const VIEWER = "00000000-0000-4000-8000-000000000004";
export const USERS = [OWNER, STAFF, PRIVATE, VIEWER];

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ""}'`).join(", ")})`)
    .join(", ");

export const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
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
create table organization_users (
  organization_id text not null, user_id uuid not null, role text not null, via text,
  disabled_at timestamptz
);
create table customer_contacts (
  customer_id text not null, organization_id text not null, user_id uuid not null, role text not null,
  via text, disabled_at timestamptz
);
insert into organization_users values
  ('T', '${OWNER}', 'owner', 'staff', null), ('B', '${OWNER}', 'owner', 'staff', now()),
  ('T', '${STAFF}', 'member', 'staff', now()), ('B', '${VIEWER}', 'viewer', 'staff', null);
insert into customer_contacts values
  ('A', 'T', '${PRIVATE}', 'contact', 'contact', now()), ('C', 'B', '${STAFF}', 'contact', 'contact', null);
create table organization (id text primary key);
create table quote (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table invoice (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
insert into quote values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into invoice values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into asset values ${values(assets, ["id", "organization_id", "customer_id"])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;
