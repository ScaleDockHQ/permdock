import type { Permission } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  listPermissions,
  resource,
  role,
} from "permdock";

const ACTIONS = ["read", "list", "create", "update", "delete"] as const;

export const permissions = definePermissions(
  Object.fromEntries(
    Array.from({ length: 38 }, (_, index) => [
      `area${String(index)}`,
      resource({
        actions: [...ACTIONS],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
      }),
    ]),
  ),
);

const leaves: readonly Permission[] = listPermissions(permissions);
const reads = leaves.filter((leaf) => leaf.action === "read");
const writes = leaves.filter((leaf) => leaf.action !== "read");

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("admin", [allow(leaves)], { on: "tenant", assignable: true }),
    role("member", [allow(reads)], { on: "tenant", assignable: true }),
    role("editor", [allow(writes.slice(0, 60))], {
      on: "tenant",
      assignable: true,
    }),
    role("frozen", [deny(writes.slice(0, 20))], { on: "tenant" }),
    role("auditor", [allow(reads.slice(0, 10))]),
  ],
  subject: () => null,
});
