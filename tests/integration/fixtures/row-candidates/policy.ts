import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  inherit,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  space: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  item: resource({
    id: "id",
    actions: ["read", "archive"],
    links: { space: { field: "spaceId", resource: "space" } },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { item, space } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(space.read)], { on: "tenant", assignable: true }),
    role(
      "archivist",
      [allow(item.archive), deny(item.archive, { where: { locked: true } })],
      { on: "tenant" },
    ),
  ],
  grants: [
    allow(item.read, { to: inherit(space.read, { through: ["space"] }) }),
  ],
  subject: () => null,
});

export const TENANTS = 20;
export const SPACES = 2_000;
export const ITEMS = 40_000;

export const uuid = (prefix: number, n: number): string =>
  `00000000-0000-4000-${String(8000 + prefix)}-${String(n).padStart(12, "0")}`;

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
         case when n % 2 = 0 then 'member' else 'archivist' end
  from generate_series(0, ${TENANTS - 1}) n;
create table public.space (id uuid primary key, "orgId" text not null);
create table public.item (
  id uuid primary key,
  "orgId" text not null,
  "spaceId" uuid not null references public.space (id),
  locked boolean not null
);
insert into public.space
  select ('00000000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid,
         'org-' || lpad((n % ${TENANTS})::text, 2, '0')
  from generate_series(0, ${SPACES - 1}) n;
insert into public.item
  select ('00000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid,
         'org-' || lpad((n % ${TENANTS})::text, 2, '0'),
         ('00000000-0000-4000-8001-' || lpad((n % ${SPACES})::text, 12, '0'))::uuid,
         n % 7 = 0
  from generate_series(0, ${ITEMS - 1}) n;
grant select on public.space, public.item to authenticated;
analyze;
`;
