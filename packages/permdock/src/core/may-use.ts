import type { SnapshotGrant } from "./interfaces.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permissions.ts";
import type { Delegation } from "./subject.ts";

import { coveredByDelegation } from "./delegation.ts";
import { resolveScope, scopeList, tenantOf } from "./scopes.ts";
import { isMembershipExpired, nowSeconds } from "./tenancy.ts";
import { isActive } from "./validity.ts";

function delegationMayCover(
  permission: Permission,
  delegation: Delegation | undefined,
  hasActor: boolean,
): boolean {
  const identifiers = [
    ...(delegation?.access ?? []),
    ...(delegation?.authorizationDetails ?? []),
  ].flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    typeof entry["identifier"] === "string"
      ? [entry["identifier"]]
      : [],
  );
  return [undefined, ...identifiers].some(
    (id) =>
      coveredByDelegation(permission, delegation, id, hasActor) === undefined,
  );
}

function blocksEveryRow(grant: SnapshotGrant): boolean {
  return (
    grant.effect === "deny" &&
    grant.where === undefined &&
    grant.check === undefined &&
    grant.portable !== false &&
    grant.fields === undefined &&
    (grant.scope === undefined || grant.scope === "tenant")
  );
}

/**
 * Whether `permission` could be granted to this instance's subject for some
 * row: the grants its snapshot carries for the active tenant, minus an
 * unconditional deny, within its delegation. A listing hint for tools and
 * skills, never a decision; the call itself is decided in full.
 */
export function mayUse(permdock: PermDock, permission: Permission): boolean {
  try {
    const snapshot = permdock.snapshot();
    if (!("grants" in snapshot)) {
      return false;
    }
    const ceiling = snapshot.delegated;
    if (ceiling !== undefined && !ceiling.includes(permission.key)) {
      return false;
    }
    if (
      !delegationMayCover(
        permission,
        permdock.subject.delegation,
        permdock.subject.actor !== undefined && ceiling === undefined,
      )
    ) {
      return false;
    }
    const tenant = permdock.subject.principal?.tenant;
    const scopes = scopeList(snapshot.scopes);
    const grants = snapshot.grants.filter((grant) => {
      if (grant.permission !== permission.key) {
        return false;
      }
      const owner =
        grant.membership === undefined
          ? undefined
          : tenantOf(grant.membership, scopes);
      return owner === undefined || owner === tenant;
    });
    if (grants.some(blocksEveryRow)) {
      return false;
    }
    return grants.some((grant) => grant.effect === "allow");
  } catch {
    return false;
  }
}

/**
 * The instances of `scope` in which the subject holds `permission` with no
 * row condition: an unconditional allow on a live membership of exactly that
 * scope, minus the instances a deny of the permission reaches there, within
 * its delegation. The in-process mirror of the SQL
 * `permitted_<scope>_ids_by_permission`; `within` keeps the instances of one
 * tenant. A listing, never a decision: a row's own check still runs `can`.
 */
export function permittedIds(
  permdock: PermDock,
  permission: Permission,
  scope: string,
  options: { readonly within?: string } = {},
): readonly string[] {
  try {
    const snapshot = permdock.snapshot({ tenants: "all" });
    if (!("grants" in snapshot)) {
      return [];
    }
    const scopes = scopeList(snapshot.scopes);
    const name = resolveScope(scopes, scope);
    const ceiling = snapshot.delegated;
    if (
      name === undefined ||
      (ceiling !== undefined && !ceiling.includes(permission.key)) ||
      !delegationMayCover(
        permission,
        permdock.subject.delegation,
        permdock.subject.actor !== undefined && ceiling === undefined,
      )
    ) {
      return [];
    }
    const now = nowSeconds();
    const allowed = new Set<string>();
    const denied = new Set<string>();
    for (const grant of snapshot.grants) {
      const membership = grant.membership;
      if (
        grant.permission !== permission.key ||
        grant.scope !== name ||
        membership?.scope !== name ||
        membership.id === undefined ||
        isMembershipExpired(membership, now) ||
        (options.within !== undefined &&
          tenantOf(membership, scopes) !== options.within)
      ) {
        continue;
      }
      if (grant.effect === "deny") {
        denied.add(membership.id);
      } else if (
        grant.where === undefined &&
        grant.check === undefined &&
        grant.portable !== false &&
        grant.fields === undefined &&
        isActive(grant.validity, now)
      ) {
        allowed.add(membership.id);
      }
    }
    return [...allowed].filter((id) => !denied.has(id)).toSorted();
  } catch {
    return [];
  }
}
