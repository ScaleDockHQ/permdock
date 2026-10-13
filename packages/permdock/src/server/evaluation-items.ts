import type { Permission, PermissionTree } from "../core/permission-types.ts";

import { formerKeys, formerScopes } from "../core/permission-leaf.ts";
import { listPermissions } from "../core/permission-registry.ts";

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

/** AuthZEN's sentinel resource id for a collection: the type as a whole, no row. */
export const COLLECTION_ID = "*";

/** A resource id as a row id: `undefined` for none, a non-scalar or the collection sentinel `*`. */
export function wireResourceId(id: unknown): string | undefined {
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  const text = String(id);
  return text === COLLECTION_ID ? undefined : text;
}

/** The row an item's resource describes: its `properties`, else `{ id }`, else none for `id: "*"`. */
export function itemResourceData(
  resource: EvaluationResource | undefined,
): unknown {
  const properties = resource?.properties;
  if (properties !== null && typeof properties === "object") {
    return properties;
  }
  const id = wireResourceId(resource?.id);
  return id === undefined ? undefined : { id };
}
