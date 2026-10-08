import type { Permission, PermissionTree } from "../core/permissions.ts";

import {
  formerKeys,
  formerScopes,
  listPermissions,
} from "../core/permissions.ts";

/** The `resource` of an AuthZEN evaluation item, unvalidated. */
export type EvaluationResource = {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly properties?: unknown;
};

/** Resolves the permission an evaluation item names. */
export type PermissionLookup = (
  action: string | undefined,
  resource: EvaluationResource | undefined,
) => Permission | undefined;

function firstWins(
  map: Map<string, Permission>,
  name: string,
  leaf: Permission,
): void {
  if (!map.has(name)) {
    map.set(name, leaf);
  }
}

/**
 * Indexes `tree` once. The lookup tries `action` as a permission key or
 * scope, then `<resource.type>.<action>`, then the leaf with that resource
 * and action; current names win over former ones and earlier leaves over
 * later ones. Anything else is `undefined`, which the caller denies.
 */
export function permissionLookup(tree: PermissionTree): PermissionLookup {
  const current = new Map<string, Permission>();
  const former = new Map<string, Permission>();
  const byPair = new Map<string, Permission>();
  for (const leaf of listPermissions(tree)) {
    firstWins(current, leaf.key, leaf);
    firstWins(current, leaf.scope, leaf);
    for (const name of [...formerKeys(leaf), ...formerScopes(leaf)]) {
      firstWins(former, name, leaf);
    }
    firstWins(byPair, `${leaf.resource}\u0000${leaf.action}`, leaf);
  }
  const named = (name: string): Permission | undefined =>
    current.get(name) ?? former.get(name);
  return (action, resource) => {
    if (action === undefined) {
      return undefined;
    }
    const byKey = named(action);
    if (byKey !== undefined) {
      return byKey;
    }
    const type = typeof resource?.type === "string" ? resource.type : undefined;
    if (type === undefined) {
      return undefined;
    }
    return named(`${type}.${action}`) ?? byPair.get(`${type}\u0000${action}`);
  };
}

/** The row an item's resource describes: its `properties`, else `{ id }`. */
export function itemResourceData(
  resource: EvaluationResource | undefined,
): unknown {
  const properties = resource?.properties;
  if (properties !== null && typeof properties === "object") {
    return properties;
  }
  const id = resource?.id;
  if (typeof id === "string" || typeof id === "number") {
    return { id: String(id) };
  }
  return undefined;
}
