import type { Membership } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  memoryRelations,
  relation,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  file: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  node: resource({
    id: "id",
    actions: ["read", "update"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: { principal: "ownerId" },
      editor: {
        edge: "node_shares",
        object: "node_id",
        subject: "user_id",
        match: { role: "editor" },
      },
      viewer: {
        edge: "node_shares",
        object: "node_id",
        subject: "user_id",
        match: { role: "viewer" },
        includes: ["editor"],
      },
    },
  }),
});

const { file, node } = permissions;

export type KeysUser = {
  readonly id: string;
  readonly memberships: readonly Membership[];
};

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(file.read), allow(file.update)], {
      on: "tenant",
      assignable: true,
    }),
  ],
  grants: [
    allow(node.read, { to: relation(node, "viewer"), requires: file.read }),
    allow(node.update, { to: relation(node, "editor"), requires: file.read }),
    allow(node.read, { to: relation(node, "owner"), requires: file.read }),
    allow(node.update, {
      to: relation(node, "owner"),
      requires: [file.read, file.update],
    }),
  ],
  subject: (user: KeysUser) => ({
    id: user.id,
    memberships: user.memberships,
  }),
});

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const users: readonly KeysUser[] = [
  { id: uuid(1), memberships: [{ tenant: "acme", roles: ["member"] }] },
  { id: uuid(2), memberships: [{ tenant: "acme", roles: ["member"] }] },
  { id: uuid(3), memberships: [{ tenant: "acme", roles: ["member"] }] },
  { id: uuid(4), memberships: [] },
];

export const nodes = [
  { id: "n-owned", orgId: "acme", ownerId: uuid(1) },
  { id: "n-edit", orgId: "acme", ownerId: uuid(3) },
  { id: "n-view", orgId: "acme", ownerId: uuid(3) },
];

export const shares = [
  { node_id: "n-edit", user_id: uuid(2), role: "editor" },
  { node_id: "n-view", user_id: uuid(2), role: "viewer" },
  { node_id: "n-edit", user_id: uuid(4), role: "editor" },
];

export const relations = memoryRelations(permissions, {
  tables: { node_shares: shares },
});

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
insert into auth.users (id) values ${users.map((user) => `('${user.id}')`).join(", ")};
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
${users
  .flatMap((user) =>
    user.memberships.flatMap((membership) =>
      membership.roles.map(
        (name) => `  ('${membership.tenant ?? ""}', '${user.id}', '${name}')`,
      ),
    ),
  )
  .join(",\n")};
create table public.file (id text primary key, "orgId" text not null);
create table public.node (id text primary key, "orgId" text not null, "ownerId" uuid not null, name text not null default '');
create table public.node_shares (node_id text not null references public.node (id), user_id uuid not null, role text not null);
insert into public.node (id, "orgId", "ownerId") values ${nodes.map((row) => `('${row.id}', '${row.orgId}', '${row.ownerId}')`).join(", ")};
insert into public.node_shares values ${shares.map((row) => `('${row.node_id}', '${row.user_id}', '${row.role}')`).join(", ")};
grant select on public.file, public.node, public.node_shares to authenticated;
grant update on public.node to authenticated;
`;
