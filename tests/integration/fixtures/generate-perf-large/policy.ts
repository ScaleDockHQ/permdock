import type { Condition, Permission, Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  isPermission,
  principal,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * Large generator fixture: 6 scopes, 40 resources, 1,800 grants, 200
 * conditions, levels on 8 resources and row helpers on 10. Built by loops so
 * every run emits the same bytes. `scripts/generate-perf.ts` times `permdock
 * generate` against it next to the small `generate-perf` fixture.
 */
const SCOPES = [
  "organization",
  "region",
  "site",
  "workspace",
  "squad",
  "project",
] as const;
const ACTIONS = ["read", "create", "update", "delete", "export"] as const;
const RESOURCES = 40;
const GRANTS = 1_800;
const LEVELLED = 8;

const names = Array.from(
  { length: RESOURCES },
  (_, index) => `res${String(index).padStart(2, "0")}`,
);

const row = z.object({
  id: z.string(),
  organization_id: z.string(),
  region_id: z.string(),
  site_id: z.string(),
  workspace_id: z.string(),
  squad_id: z.string(),
  team_id: z.string(),
  project_id: z.string(),
  owner_id: z.string(),
  status: z.string(),
  priority: z.string(),
  archived: z.boolean(),
});

const relations = Object.fromEntries(
  SCOPES.map((scope) => [scope, { field: `${scope}_id`, memberOf: scope }]),
);

export const permissions = definePermissions(
  Object.fromEntries(
    names.map((name, index) => [
      name,
      resource(row, {
        id: "id",
        actions: [...ACTIONS],
        relations,
        ...(index < LEVELLED
          ? {
              levels: {
                own: { owner_id: principal.id },
                team: { team_id: { in: { ref: "principal.claims.team_ids" } } },
                all: {},
              },
            }
          : {}),
      }),
    ]),
  ),
);

const STATUSES = Array.from({ length: 98 }, (_, index) => `s${index}`);

/** 200 distinct conditions: 98 `eq`, 98 `ne` on status, then four fixed ones. */
const CONDITIONS: readonly Condition[] = [
  ...STATUSES.map((value): Condition => ({ op: "eq", field: "status", value })),
  ...STATUSES.map((value): Condition => ({ op: "ne", field: "status", value })),
  { op: "eq", field: "owner_id", value: { ref: "principal.id" } },
  { op: "eq", field: "archived", value: false },
  { op: "in", field: "priority", value: ["high", "urgent"] },
  { op: "eq", field: "archived", value: true },
];

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

/** `GRANTS` grants spread over the 200 keys, in a fixed order. */
function grantsFor(): ReturnType<typeof allow>[] {
  const keys = names.flatMap((name) =>
    ACTIONS.map((action) => permissionAt(name, action)),
  );
  const grants: ReturnType<typeof allow>[] = [];
  for (let index = 0; index < GRANTS; index += 1) {
    const leaf = keys[index % keys.length];
    const where = CONDITIONS[index % CONDITIONS.length];
    if (leaf === undefined || where === undefined) {
      throw new TypeError("fixture index out of range");
    }
    grants.push(
      index % 11 === 10 ? deny(leaf, { where }) : allow(leaf, { where }),
    );
  }
  return grants;
}

const all = grantsFor();
const slice = Math.floor(all.length / SCOPES.length);

export const policy = definePolicy(permissions, {
  scopes: {
    organization: { key: "organization_id" },
    region: { key: "region_id", within: "organization" },
    site: { key: "site_id", within: "region" },
    workspace: { key: "workspace_id", within: "site" },
    squad: { key: "squad_id", within: "workspace" },
    project: { key: "project_id", within: "squad" },
  },
  subject: (user: Principal | null) => user,
  roles: SCOPES.map((scope, index) =>
    role(`${scope}-admin`, all.slice(index * slice, (index + 1) * slice), {
      on: scope,
    }),
  ),
});
