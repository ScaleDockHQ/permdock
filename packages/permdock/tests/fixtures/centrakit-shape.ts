import type { Condition } from "../../src/conditions/ast.ts";
import type { Principal } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { permissions } from "./large-policy.ts";

/**
 * The shape of a multi-organisation commerce user: 11 memberships over three
 * declared roles, about 2,200 grants in the expanded form. It models the shape
 * of one CentraKit capture and is not a measurement of CentraKit.
 */
const CENTRAKIT_TENANTS = Array.from(
  { length: 11 },
  (_, index) => `org${index}`,
);

const OWN: Condition = {
  op: "eq",
  field: "ownerId",
  value: { ref: "principal.id" },
};
const OPEN: Condition = { op: "ne", field: "status", value: "closed" };

const leaves = listPermissions(permissions);

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: Principal) => user,
  roles: [
    role(
      "admin",
      leaves.flatMap((leaf) => [allow(leaf), allow(leaf, { where: OPEN })]),
      { on: "tenant" },
    ),
    role(
      "member",
      leaves.map((leaf) => allow(leaf, { where: OWN })),
      { on: "tenant" },
    ),
    role(
      "viewer",
      leaves
        .filter((leaf) => leaf.action === "read")
        .map((leaf) => allow(leaf, { where: OPEN })),
      { on: "tenant" },
    ),
  ],
});

/** Admin in the first organisation, member in five, viewer in five. */
export function commerceUser(): Principal {
  return {
    id: "u-commerce",
    tenant: "org0",
    memberships: CENTRAKIT_TENANTS.map((tenant, index) => ({
      scope: "tenant",
      id: tenant,
      roles: [index === 0 ? "admin" : index <= 5 ? "member" : "viewer"],
    })),
  };
}
