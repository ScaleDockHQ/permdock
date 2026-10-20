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

/** `file` and `fileNode` of `split/` merged into one resource. */
export const permissions = definePermissions(
  {
    file: resource({
      id: "id",
      actions: ["read", "update", "comment"],
      parent: { field: "parentId", resource: "file" },
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
  },
  {
    renamed: {
      "fileNode.read": "file.read",
      "fileNode.comment": "file.comment",
    },
  },
);

const { file } = permissions;

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
    allow(file.read, { to: relation(file, "owner") }),
    allow(file.read, { to: relation(file, "viewer", { through: "parent" }) }),
    allow(file.comment, {
      to: relation(file, "viewer", { through: "parent" }),
    }),
  ],
  subject: (user: FileUser) => subject(user),
});

export const relations = memoryRelationSource(permissions, {
  rows: { file: rows },
  tables: { file_node_shares: shares },
});
