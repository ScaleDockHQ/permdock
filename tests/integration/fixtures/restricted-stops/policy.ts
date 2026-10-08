import type { Membership, ResourceRestricted } from "permdock";

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

function tree(name: string, restricted: string | ResourceRestricted) {
  return resource({
    id: "id",
    actions: ["read", "update"],
    parent: { field: "parentId", resource: name },
    links: { drive: { field: "driveId", resource: "drive" } },
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: {
        edge: `${name}_shares`,
        object: "object_id",
        subject: "user_id",
      },
    },
    restricted,
  });
}

export const permissions = definePermissions({
  drive: resource({
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
      viewer: { edge: "drive_shares", object: "drive_id", subject: "user_id" },
    },
  }),
  node: tree("node", { field: "restricted", stops: ["parent"] }),
  item: tree("item", "restricted"),
  entry: tree("entry", { field: "restricted", stops: ["drive"] }),
});

const { drive, node, item, entry } = permissions;

export const trees = ["node", "item", "entry"] as const;

export type TreeName = (typeof trees)[number];

export const treePermissions = {
  node: { read: node.read, update: node.update },
  item: { read: item.read, update: item.update },
  entry: { read: entry.read, update: entry.update },
} as const;

export type RestrictedUser = {
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
    allow(drive.read, { to: relation(drive, "owner") }),
    allow(drive.read, { to: relation(drive, "viewer") }),
    ...[node, item, entry].flatMap((leaves) => [
      allow(leaves.read, {
        to: relation(leaves, "viewer", { through: "parent", depth: 16 }),
      }),
      allow(leaves.read, {
        to: inherit(drive.read, { through: ["drive"] }),
      }),
      allow(leaves.update, {
        to: relation(drive, "owner", { through: ["drive"] }),
      }),
    ]),
  ],
  subject: (user: RestrictedUser) => ({
    id: user.id,
    ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
    memberships: user.memberships,
  }),
});

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const users: readonly RestrictedUser[] = [
  { id: uuid(1), memberships: [] },
  { id: uuid(2), memberships: [] },
  { id: uuid(3), memberships: [] },
  {
    id: uuid(4),
    tenant: "acme",
    memberships: [{ tenant: "acme", roles: ["member"] }],
  },
  { id: uuid(5), memberships: [] },
  { id: uuid(6), memberships: [] },
];

export const drives = [
  { id: "d1", orgId: "acme", ownerId: uuid(1) },
  { id: "d2", orgId: "other", ownerId: uuid(6) },
];

export type TreeRow = {
  readonly id: string;
  readonly orgId: string;
  readonly driveId: string;
  readonly parentId: string | null;
  readonly restricted: boolean;
};

const chain: readonly TreeRow[] = Array.from({ length: 35 }, (_, index) => ({
  id: `c${String(index + 1).padStart(2, "0")}`,
  orgId: "acme",
  driveId: "d1",
  parentId: index === 0 ? "root" : `c${String(index).padStart(2, "0")}`,
  restricted: false,
}));

export const rows: readonly TreeRow[] = [
  {
    id: "root",
    orgId: "acme",
    driveId: "d1",
    parentId: null,
    restricted: false,
  },
  {
    id: "open",
    orgId: "acme",
    driveId: "d1",
    parentId: "root",
    restricted: false,
  },
  {
    id: "secret",
    orgId: "acme",
    driveId: "d1",
    parentId: "root",
    restricted: true,
  },
  {
    id: "inner",
    orgId: "acme",
    driveId: "d1",
    parentId: "secret",
    restricted: false,
  },
  {
    id: "deep",
    orgId: "acme",
    driveId: "d1",
    parentId: "inner",
    restricted: false,
  },
  {
    id: "vault",
    orgId: "acme",
    driveId: "d1",
    parentId: "deep",
    restricted: true,
  },
  {
    id: "under",
    orgId: "acme",
    driveId: "d1",
    parentId: "vault",
    restricted: false,
  },
  {
    id: "loose",
    orgId: "acme",
    driveId: "d1",
    parentId: "gone",
    restricted: false,
  },
  {
    id: "other",
    orgId: "other",
    driveId: "d2",
    parentId: null,
    restricted: true,
  },
  ...chain,
];

export const shares = {
  drive: [{ object_id: "d1", user_id: uuid(2) }],
  tree: [
    { object_id: "secret", user_id: uuid(3) },
    { object_id: "root", user_id: uuid(5) },
    { object_id: "deep", user_id: uuid(6) },
  ],
};

export const relations = memoryRelations(permissions, {
  rows: { drive: drives, node: rows, item: rows, entry: rows },
  tables: {
    drive_shares: shares.drive.map((row) => ({
      drive_id: row.object_id,
      user_id: row.user_id,
    })),
    node_shares: shares.tree,
    item_shares: shares.tree,
    entry_shares: shares.tree,
  },
});

const literal = (value: string | null): string =>
  value === null ? "null" : `'${value}'`;

const treeTable = (name: TreeName): string => `
create table public.${name} (
  id text primary key,
  "orgId" text not null,
  "driveId" text not null references public.drive (id),
  "parentId" text,
  restricted boolean not null
);
create table public.${name}_shares (object_id text not null, user_id uuid not null);
insert into public.${name} values ${rows.map((row) => `('${row.id}', '${row.orgId}', '${row.driveId}', ${literal(row.parentId)}, ${String(row.restricted)})`).join(", ")};
insert into public.${name}_shares values ${shares.tree.map((row) => `('${row.object_id}', '${row.user_id}')`).join(", ")};
grant select on public.${name}, public.${name}_shares to authenticated;
`;

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
create table public.drive (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.drive_shares (drive_id text not null references public.drive (id), user_id uuid not null);
insert into public.drive values ${drives.map((row) => `('${row.id}', '${row.orgId}', '${row.ownerId}')`).join(", ")};
insert into public.drive_shares values ${shares.drive.map((row) => `('${row.object_id}', '${row.user_id}')`).join(", ")};
grant select on public.drive, public.drive_shares to authenticated;
${trees.map(treeTable).join("")}`;
