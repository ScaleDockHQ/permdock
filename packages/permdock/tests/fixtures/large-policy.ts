import type { Condition } from "../../src/conditions/ast.ts";
import type { Principal } from "../../src/core/subject.ts";

import { allow, deny } from "../../src/core/grant-builders.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "export",
  "archive",
  "assign",
] as const;
const RESOURCES = 39;

export const TENANTS = Array.from({ length: 10 }, (_, index) => `o${index}`);

const names = Array.from(
  { length: RESOURCES },
  (_, index) => `res${String(index).padStart(2, "0")}`,
);

export const permissions = definePermissions(
  Object.fromEntries(
    names.map((name) => [
      name,
      resource({
        id: "id",
        actions: [...ACTIONS],
        relations: { org: { field: "orgId", memberOf: "tenant" } },
      }),
    ]),
  ),
);

export const STATUSES = Array.from({ length: 12 }, (_, index) => `s${index}`);

/** The distinct `where` conditions the generated grants draw from. */
const CONDITIONS: readonly Condition[] = [
  ...STATUSES.map((status): Condition => ({
    op: "eq",
    field: "status",
    value: status,
  })),
  ...STATUSES.map((status): Condition => ({
    op: "ne",
    field: "status",
    value: status,
  })),
  { op: "eq", field: "ownerId", value: { ref: "principal.id" } },
  { op: "eq", field: "assigneeId", value: { ref: "principal.id" } },
  { op: "eq", field: "archived", value: false },
  { op: "in", field: "priority", value: ["high", "urgent"] },
];

function conditionAt(index: number): Condition {
  const condition = CONDITIONS[index % CONDITIONS.length];
  if (condition === undefined) {
    throw new TypeError("no conditions");
  }
  return condition;
}

/**
 * 273 permission keys; the `admin` role holds 1,790 grants over them: 6 per key
 * and a 7th on the first 152 keys, every 5th key's 7th grant a deny. Each grant
 * carries one of 28 distinct `where` conditions.
 */
function adminGrants(): ReturnType<typeof allow>[] {
  const grants: ReturnType<typeof allow>[] = [];
  let index = 0;
  for (const name of names) {
    // SAFETY: names come from the same tree definePermissions built above.
    const node = (
      permissions as unknown as Record<string, Record<string, never>>
    )[name];
    for (const action of ACTIONS) {
      const leaf = node?.[action];
      if (leaf === undefined) {
        continue;
      }
      const count = index < 152 ? 7 : 6;
      for (let n = 0; n < count; n += 1) {
        const where = conditionAt(index + n);
        const isDeny = n === 6 && index % 5 === 0;
        grants.push(isDeny ? deny(leaf, { where }) : allow(leaf, { where }));
      }
      index += 1;
    }
  }
  return grants;
}

export const ADMIN_GRANTS = 1790;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: Principal) => user,
  roles: [
    role("admin", adminGrants(), { on: "tenant" }),
    role(
      "viewer",
      names.map((name) => {
        // SAFETY: as above, a leaf of the generated tree.
        const node = (
          permissions as unknown as Record<string, Record<string, never>>
        )[name];
        // SAFETY: the read leaf is a Permission; `allow` takes it typed.
        return allow(node?.["read"] as never, {
          where: { op: "eq", field: "status", value: "s0" },
        });
      }),
      { on: "tenant" },
    ),
  ],
});

/** An admin of one tenant: the case behind the 483,122-byte snapshot. */
export function adminOf(tenant: string): Principal {
  return {
    id: `u-${tenant}`,
    tenant,
    memberships: [{ scope: "tenant", id: tenant, roles: ["admin"] }],
  };
}

/** An admin in `o0` and a viewer in every other tenant. */
export function mixed(): Principal {
  return {
    id: "u-mixed",
    tenant: "o0",
    memberships: TENANTS.map((tenant, index) => ({
      scope: "tenant",
      id: tenant,
      roles: [index === 0 ? "admin" : "viewer"],
    })),
  };
}

/** Rows that match some conditions and miss others. */
export function rowsFor(tenant: string, user: string): readonly object[] {
  return [
    { id: "r1", orgId: tenant, status: "s0", ownerId: user, archived: false },
    {
      id: "r2",
      orgId: tenant,
      status: "s7",
      assigneeId: user,
      priority: "high",
    },
    { id: "r3", orgId: "elsewhere", status: "s3", ownerId: user },
    { id: "r4", orgId: tenant, status: "s11", archived: true },
  ];
}
