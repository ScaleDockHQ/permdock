import type { Membership } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  inherit,
  memoryRelations,
  relation,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  drive: resource({
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "drive_shares", object: "drive_id", subject: "user_id" },
    },
  }),
  folder: resource({
    id: "id",
    actions: ["read"],
    links: { drive: { field: "driveId", resource: "drive" } },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  node: resource({
    id: "id",
    actions: ["read", "share"],
    links: {
      drive: { field: "driveId", resource: "drive" },
      folder: { field: "folderId", resource: "folder" },
    },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    restricted: "restricted",
  }),
});

const { drive, folder, node } = permissions;

export type InheritUser = {
  readonly id: string;
  readonly tenant?: string;
  readonly memberships: readonly Membership[];
};

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(drive.read)], { on: "tenant", assignable: true }),
  ],
  grants: [
    allow(drive.read, { to: relation(drive, "viewer") }),
    allow(folder.read, { to: inherit(drive.read, { through: ["drive"] }) }),
    allow(node.read, { to: inherit(drive.read, { through: ["drive"] }) }),
    allow(node.share, {
      to: inherit(drive.read, { through: ["folder", "drive"] }),
      where: { locked: false },
    }),
  ],
  subject: (user: InheritUser) => ({
    id: user.id,
    ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
    memberships: user.memberships,
  }),
});

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const users: readonly InheritUser[] = [
  {
    id: uuid(1),
    tenant: "acme",
    memberships: [{ tenant: "acme", roles: ["member"] }],
  },
  { id: uuid(2), memberships: [] },
  {
    id: uuid(3),
    tenant: "globex",
    memberships: [{ tenant: "globex", roles: ["member"] }],
  },
  { id: uuid(4), memberships: [] },
];

export const drives = [
  { id: "d-acme", orgId: "acme" },
  { id: "d-shared", orgId: "acme" },
  { id: "d-globex", orgId: "globex" },
];

export const folders = [
  { id: "f-acme", orgId: "acme", driveId: "d-acme" },
  { id: "f-shared", orgId: "acme", driveId: "d-shared" },
  { id: "f-globex", orgId: "globex", driveId: "d-globex" },
];

export const nodes = [
  {
    id: "n-acme",
    orgId: "acme",
    driveId: "d-acme",
    folderId: "f-shared",
    locked: false,
    restricted: false,
  },
  {
    id: "n-shared",
    orgId: "acme",
    driveId: "d-shared",
    folderId: "f-acme",
    locked: false,
    restricted: false,
  },
  {
    id: "n-locked",
    orgId: "acme",
    driveId: "d-shared",
    folderId: "f-shared",
    locked: true,
    restricted: false,
  },
  {
    id: "n-restricted",
    orgId: "acme",
    driveId: "d-shared",
    folderId: "f-shared",
    locked: false,
    restricted: true,
  },
  {
    id: "n-globex",
    orgId: "globex",
    driveId: "d-globex",
    folderId: "f-globex",
    locked: false,
    restricted: false,
  },
];

export const shares = [{ drive_id: "d-shared", user_id: uuid(2) }];

export const relations = memoryRelations(permissions, {
  rows: { drive: drives, folder: folders, node: nodes },
  tables: { drive_shares: shares },
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
create table public.drive (id text primary key, "orgId" text not null);
create table public.folder (id text primary key, "orgId" text not null, "driveId" text not null references public.drive (id));
create table public.node (
  id text primary key,
  "orgId" text not null,
  "driveId" text not null references public.drive (id),
  "folderId" text not null references public.folder (id),
  locked boolean not null,
  restricted boolean not null
);
create table public.drive_shares (drive_id text not null references public.drive (id), user_id uuid not null);
insert into public.drive values ${drives.map((row) => `('${row.id}', '${row.orgId}')`).join(", ")};
insert into public.folder values ${folders.map((row) => `('${row.id}', '${row.orgId}', '${row.driveId}')`).join(", ")};
insert into public.node values ${nodes.map((row) => `('${row.id}', '${row.orgId}', '${row.driveId}', '${row.folderId}', ${String(row.locked)}, ${String(row.restricted)})`).join(", ")};
insert into public.drive_shares values ${shares.map((row) => `('${row.drive_id}', '${row.user_id}')`).join(", ")};
grant select on public.drive, public.folder, public.node, public.drive_shares to authenticated;
`;
