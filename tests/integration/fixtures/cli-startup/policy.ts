import type { Condition, Permission, Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  isPermission,
  resource,
  role,
} from "permdock";

/**
 * CentraKit-size generator fixture: 39 resources, 7 actions, 273 permission
 * keys. The `admin` role holds 1,790 grants (6 per key, and a 7th on the first
 * 152 keys; every 5th key's 7th grant is a deny). `scripts/generate-perf.ts`
 * times `permdock` generate against this module. Keep the counts in step with
 * `packages/permdock/tests/fixtures/large-policy.ts`.
 */
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

const STATUSES = Array.from({ length: 12 }, (_, index) => `s${index}`);

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

function permissionAt(name: string, action: string): Permission {
  const node: unknown = Reflect.get(permissions, name);
  if (node === null || typeof node !== "object") {
    throw new Error(`missing resource ${name}`);
  }
  const leaf: unknown = Reflect.get(node, action);
  if (!isPermission(leaf)) {
    throw new Error(`missing permission ${name}.${action}`);
  }
  return leaf;
}

function adminGrants(): ReturnType<typeof allow>[] {
  const grants: ReturnType<typeof allow>[] = [];
  let index = 0;
  for (const name of names) {
    for (const action of ACTIONS) {
      const leaf = permissionAt(name, action);
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

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: Principal) => user,
  roles: [
    role("admin", adminGrants(), { on: "tenant" }),
    role(
      "viewer",
      names.map((name) =>
        allow(permissionAt(name, "read"), {
          where: { op: "eq", field: "status", value: "s0" },
        }),
      ),
      { on: "tenant" },
    ),
  ],
});
