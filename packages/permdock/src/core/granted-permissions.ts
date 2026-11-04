import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Snapshot, SnapshotGrant } from "./snapshot-types.ts";

import { fromSnapshot } from "./from-snapshot.ts";
import { flattenGrantee } from "./grantee.ts";
import { findPermission } from "./permission-registry.ts";
import { scopeList } from "./scopes.ts";

/** What `permdock.grantedPermissions()` lists permissions for. */
export type GrantedPermissionsOptions = {
  /** Default the active tenant. */
  readonly tenant?: string;
  /** Only memberships of this declared scope, or of this resource. */
  readonly scope?: string;
  /** Only the membership on this scope or resource instance. */
  readonly id?: string;
};

/**
 * Whether only global roles allow `permission`: it has at least one allow, and
 * every allow is granted to a role with no `on`. Read from the policy's
 * declared grants, never from the key; a custom role the policy does not
 * declare is not counted.
 */
export function isGlobalPermission(
  policy: Policy,
  permission: Permission,
): boolean {
  const allows = (policy.index.grantsByKey.get(permission.key) ?? []).filter(
    (grant) => grant.effect === "allow",
  );
  return (
    allows.length > 0 &&
    allows.every(
      (grant) =>
        grant.scope === "global" &&
        flattenGrantee(grant.to).every(
          (item) => item.kind === "role" && item.scope === "global",
        ),
    )
  );
}

function onInstance(
  entry: SnapshotGrant,
  options: GrantedPermissionsOptions,
): boolean {
  const { membership } = entry;
  if (membership === undefined) {
    return true;
  }
  if (
    options.scope !== undefined &&
    (membership.scope ?? membership.on?.resource) !== options.scope
  ) {
    return false;
  }
  return (
    options.id === undefined ||
    (membership.id ?? membership.on?.id) === options.id
  );
}

/**
 * Every permission a type-level check (`can(permission)` with no row) grants in
 * one tenant, listed in one pass over the grants `snapshot()` builds. A listing
 * to render and filter with, never a decision: a permission granted only
 * through the relationship graph or a time-bounded relation is left out, as in
 * a snapshot.
 */
export function grantedPermissionsOf(
  policy: Policy,
  snapshot: Snapshot,
  options: GrantedPermissionsOptions = {},
): readonly Permission[] {
  const grants = snapshot.grants.filter((entry) => onInstance(entry, options));
  const keys = new Set(
    grants
      .filter((entry) => entry.effect === "allow")
      .map((entry) => entry.permission),
  );
  const team = teamOf(policy, options);
  const scoped = fromSnapshot(
    { ...snapshot, grants },
    {
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      ...(team === undefined ? {} : { team }),
    },
  );
  const listed: Permission[] = [];
  for (const key of keys) {
    const permission = findPermission(policy.permissions, key);
    // SAFETY: a rowless check takes any leaf; the overloads only differ in the row a kind needs.
    if (permission !== undefined && scoped.can(permission as never)) {
      listed.push(permission);
    }
  }
  return listed;
}

/** `id` names the second scope's instance when `scope` is that scope. */
function teamOf(
  policy: Policy,
  options: GrantedPermissionsOptions,
): string | undefined {
  const second = scopeList(policy.scopes)[1];
  return second !== undefined && options.scope === second.name
    ? options.id
    : undefined;
}
