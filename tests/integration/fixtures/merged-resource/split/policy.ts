import {
  allow,
  definePermissions,
  definePolicy,
  memoryRelationSource,
  relation,
  resource,
  role,
} from "permdock";

import type { FileUser } from "../shared.ts";

import { rows, shares, subject } from "../shared.ts";

/** Org-level `file` and per-row `fileNode`, both over `file_nodes`. */
export const permissions = definePermissions({
  file: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  fileNode: resource({
    id: "id",
    actions: ["read", "comment"],
    parent: { field: "parentId", resource: "fileNode" },
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
      viewer: {
        edge: "file_node_shares",
        object: "object_id",
        subject: "user_id",
      },
    },
  }),
});

const { file, fileNode } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("admin", [allow(file.read), allow(file.update)], {
      on: "tenant",
      assignable: true,
    }),
    role("member", [allow(file.read)], { on: "tenant", assignable: true }),
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
  subject: (user: FileUser) => subject(user),
});

export const relations = memoryRelationSource(permissions, {
  rows: { file: rows, fileNode: rows },
  tables: { file_node_shares: shares },
});
