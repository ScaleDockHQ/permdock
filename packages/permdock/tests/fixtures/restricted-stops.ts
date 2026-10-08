import type { Membership, ResourceRestricted } from "../../src/index.ts";

import { inherit, relation } from "../../src/core/grantee.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { memoryRelations } from "../../src/core/relations.ts";

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

const drives = [
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

const shares = {
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
