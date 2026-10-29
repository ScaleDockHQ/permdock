import { describe, expect, it } from "vitest";

import type { Membership, Permission } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  getPermDock,
  memoryRelationSource,
  relation,
  resource,
  role,
} from "../../src/index.ts";

type User = {
  readonly id: string;
  readonly tenant?: string;
  readonly memberships: readonly Membership[];
};

type Row = {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string | null;
  readonly ownerId: string | null;
};

const rows: readonly Row[] = [
  { id: "r1", orgId: "acme", parentId: null, ownerId: "u3" },
  { id: "r2", orgId: "acme", parentId: "r1", ownerId: null },
  { id: "r3", orgId: "acme", parentId: null, ownerId: null },
  { id: "r4", orgId: "acme", parentId: "r3", ownerId: null },
  { id: "o1", orgId: "other", parentId: null, ownerId: "u3" },
];
const shares = [
  { object_id: "r3", user_id: "u4" },
  { object_id: "r1", user_id: "u5" },
];
const users: readonly User[] = [
  {
    id: "u1",
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
  },
  {
    id: "u2",
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["member"] }],
  },
  { id: "u3", memberships: [] },
  { id: "u4", memberships: [] },
  {
    id: "u5",
    tenant: "other",
    memberships: [{ scope: "tenant", id: "other", roles: ["member"] }],
  },
];

const rowRelations = {
  org: { field: "orgId", memberOf: "tenant" },
  owner: "ownerId",
  viewer: { edge: "file_node_shares", object: "object_id", subject: "user_id" },
} as const;

const subject = (user: User) => ({
  id: user.id,
  ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
  memberships: user.memberships,
});

const splitPermissions = definePermissions({
  file: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  fileNode: resource({
    id: "id",
    actions: ["read", "comment"],
    parent: { field: "parentId", resource: "fileNode" },
    relations: rowRelations,
  }),
});
const { file, fileNode } = splitPermissions;
const splitPolicy = definePolicy(splitPermissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("admin", [allow(file.read), allow(file.update)], { on: "tenant" }),
    role("member", [allow(file.read)], { on: "tenant" }),
  ],
  grants: [
    allow(fileNode.read, { to: relation(fileNode, "owner") }),
    allow(fileNode.read, {
      to: relation(fileNode, "viewer", { through: "parent" }),
    }),
    allow(fileNode.comment, {
      to: relation(fileNode, "viewer", { through: "parent" }),
    }),
  ],
  subject,
});

const mergedPermissions = definePermissions(
  {
    file: resource({
      id: "id",
      actions: ["read", "update", "comment"],
      parent: { field: "parentId", resource: "file" },
      relations: rowRelations,
    }),
  },
  {
    renamed: {
      "fileNode.read": "file.read",
      "fileNode.comment": "file.comment",
    },
  },
);
const merged = mergedPermissions.file;
const mergedPolicy = definePolicy(mergedPermissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("admin", [allow(merged.read), allow(merged.update)], { on: "tenant" }),
    role("member", [allow(merged.read)], { on: "tenant" }),
  ],
  grants: [
    allow(merged.read, { to: relation(merged, "owner") }),
    allow(merged.read, {
      to: relation(merged, "viewer", { through: "parent" }),
    }),
    allow(merged.comment, {
      to: relation(merged, "viewer", { through: "parent" }),
    }),
  ],
  subject,
});

const splitRelations = memoryRelationSource(splitPermissions, {
  rows: { file: rows, fileNode: rows },
  tables: { file_node_shares: shares },
});
const mergedRelations = memoryRelationSource(mergedPermissions, {
  rows: { file: rows },
  tables: { file_node_shares: shares },
});

async function readable(
  permdock: {
    readonly prefetchRelations: (
      permission: Permission,
      rows: readonly Row[],
    ) => unknown;
    readonly can: (permission: Permission, row: Row) => boolean;
  },
  permissions: readonly Permission[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const permission of permissions) {
    await permdock.prefetchRelations(permission, rows);
    for (const row of rows) {
      if (permdock.can(permission, row)) {
        ids.add(row.id);
      }
    }
  }
  return [...ids].toSorted();
}

const pairs = [
  { merged: merged.read, split: [file.read, fileNode.read] },
  { merged: merged.update, split: [file.update] },
  { merged: merged.comment, split: [fileNode.comment] },
] as const;

describe("one resource for org-level and per-row access", () => {
  for (const user of users) {
    it(`reaches the union of the split keys for ${user.id}`, async () => {
      const before = await getPermDock(splitPolicy, user, {
        relations: splitRelations,
      });
      const after = await getPermDock(mergedPolicy, user, {
        relations: mergedRelations,
      });
      for (const pair of pairs) {
        expect(await readable(after, [pair.merged])).toStrictEqual(
          await readable(before, pair.split),
        );
      }
    });
  }

  it("keeps the role branch and the relation branches", async () => {
    const reads = await Promise.all(
      users.map(async (user) =>
        readable(
          await getPermDock(mergedPolicy, user, { relations: mergedRelations }),
          [merged.read],
        ),
      ),
    );
    expect(reads).toStrictEqual([
      ["r1", "r2", "r3", "r4"],
      ["r1", "r2", "r3", "r4"],
      ["o1", "r1"],
      ["r3", "r4"],
      ["o1", "r1", "r2"],
    ]);
  });
});
