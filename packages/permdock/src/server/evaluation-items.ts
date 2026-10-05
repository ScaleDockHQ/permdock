import type { Permission, PermissionTree } from "../core/permissions.ts";

import { findPermission, listPermissions } from "../core/permissions.ts";

/** The `resource` of an AuthZEN evaluation item, unvalidated. */
export type EvaluationResource = {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly properties?: unknown;
};

/**
 * The permission an evaluation item names: `action` as a permission key,
 * then `<resource.type>.<action>`, then the leaf with that resource and
 * action. Anything else is `undefined`, which the caller denies.
 */
export function itemPermission(
  tree: PermissionTree,
  action: string | undefined,
  resource: EvaluationResource | undefined,
): Permission | undefined {
  if (action === undefined) {
    return undefined;
  }
  const byKey = findPermission(tree, action);
  if (byKey !== undefined) {
    return byKey;
  }
  const type = typeof resource?.type === "string" ? resource.type : undefined;
  if (type === undefined) {
    return undefined;
  }
  return (
    findPermission(tree, `${type}.${action}`) ??
    listPermissions(tree).find(
      (leaf) => leaf.resource === type && leaf.action === action,
    )
  );
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
