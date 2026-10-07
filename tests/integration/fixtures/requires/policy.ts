import type { Membership } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  memoryRelations,
  relation,
  resource,
  role,
} from "permdock";

// A drive share counts only in an organization where the user also holds
// file.read through a role: the organization ceiling on a relationship.
export const permissions = definePermissions({
  drive: resource({
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "drive_shares", object: "drive_id", subject: "user_id" },
    },
  }),
  file: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { drive, file } = permissions;

export type RequiresUser = {
  readonly id: string;
  readonly memberships: readonly Membership[];
};

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(file.read)], { on: "tenant", assignable: true }),
    role("guest", [allow(file.read, { where: { orgId: "none" } })], {
      on: "tenant",
      assignable: true,
    }),
    role("blocked", [deny(file.read)], { on: "tenant" }),
  ],
  grants: [
    allow(drive.read, {
      to: relation(drive, "viewer"),
      requires: file.read,
    }),
  ],
  subject: (user: RequiresUser) => ({
    id: user.id,
    memberships: user.memberships,
  }),
});

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const users: readonly RequiresUser[] = [
  { id: uuid(1), memberships: [{ tenant: "acme", roles: ["member"] }] },
  { id: uuid(2), memberships: [{ tenant: "acme", roles: ["guest"] }] },
  {
    id: uuid(3),
    memberships: [
      { tenant: "acme", roles: ["member", "blocked"] },
      { tenant: "globex", roles: ["member"] },
    ],
  },
  { id: uuid(4), memberships: [{ tenant: "acme", roles: ["reader"] }] },
  { id: uuid(5), memberships: [{ tenant: "globex", roles: ["member"] }] },
  { id: uuid(6), memberships: [] },
];

export const drives = [
  { id: "d-acme", orgId: "acme" },
  { id: "d-globex", orgId: "globex" },
  { id: "d-unshared", orgId: "acme" },
];

export const shares = users.flatMap((user) =>
  ["d-acme", "d-globex"].map((drive_id) => ({ drive_id, user_id: user.id })),
);

export const relations = memoryRelations(permissions, {
  tables: { drive_shares: shares },
});

export const customRoles = {
  rolesFor: (tenant: string) =>
    tenant === "acme"
      ? [{ name: "reader", tenant, grants: [{ permission: "file.read" }] }]
      : [],
};

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
create table public.drive (id text primary key, "orgId" text not null);
create table public.file (id text primary key, "orgId" text not null);
create table public.drive_shares (drive_id text not null references public.drive (id), user_id uuid not null);
insert into public.drive values ${drives.map((row) => `('${row.id}', '${row.orgId}')`).join(", ")};
insert into public.drive_shares values ${shares.map((row) => `('${row.drive_id}', '${row.user_id}')`).join(", ")};
grant select on public.drive, public.file, public.drive_shares to authenticated;
`;

export const customRoleSql = `insert into permdock.custom_role_permissions (tenant_id, role, permission) values ('acme', 'reader', 'file.read');`;
