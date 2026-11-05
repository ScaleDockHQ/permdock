import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  item: resource({
    id: "id",
    actions: ["read", "edit"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { item } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(item.read)], { on: "tenant" }),
    role("editor", [allow(item.edit, { where: { locked: false } })], {
      on: "tenant",
    }),
  ],
  subject: () => null,
});

export const TENANTS = 10;
export const ROWS = 5_000;

export const setupSql = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
  from generate_series(0, ${TENANTS - 1}) n;
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create index on public.organization_members (user_id);
insert into public.organization_members
  select 'org-' || lpad(n::text, 2, '0'),
         ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         case when n % 2 = 0 then 'member' else 'editor' end
  from generate_series(0, ${TENANTS - 1}) n;
create table public.item (
  id uuid primary key,
  "orgId" text not null,
  locked boolean not null
);
create index on public.item ("orgId");
insert into public.item
  select ('00000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid,
         'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         n % 7 = 0
  from generate_series(0, ${ROWS - 1}) n;
grant select on public.item to authenticated;
analyze;
`;
