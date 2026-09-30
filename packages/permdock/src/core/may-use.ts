import type { SnapshotGrant } from './interfaces.ts';
import type { PermDock } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Delegation } from './subject.ts';

import { coveredByDelegation } from './delegation.ts';
import { scopeList, tenantOf } from './scopes.ts';

function delegationMayCover(
  permission: Permission,
  delegation: Delegation | undefined,
  hasActor: boolean,
): boolean {
  const identifiers = [
    ...(delegation?.access ?? []),
    ...(delegation?.authorizationDetails ?? []),
  ].flatMap((entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.identifier === 'string'
      ? [entry.identifier]
      : [],
  );
  return [undefined, ...identifiers].some(
    (id) =>
      coveredByDelegation(permission, delegation, id, hasActor) === undefined,
  );
}

function blocksEveryRow(grant: SnapshotGrant): boolean {
  return (
    grant.effect === 'deny' &&
    grant.where === undefined &&
    grant.check === undefined &&
    grant.portable !== false &&
    grant.fields === undefined &&
    (grant.scope === undefined || grant.scope === 'tenant')
  );
}

/**
 * Whether `permission` could be granted to this instance's subject for some
 * row: the grants its snapshot carries for the active tenant, minus an
 * unconditional deny, within its delegation. A listing hint for tools and
 * skills, never a decision; the call itself is decided in full.
 */
export function mayUse(dock: PermDock, permission: Permission): boolean {
  try {
    const snapshot = dock.snapshot();
    if (!('grants' in snapshot)) {
      return false;
    }
    if (
      !delegationMayCover(
        permission,
        dock.subject.delegation,
        dock.subject.actor !== undefined,
      )
    ) {
      return false;
    }
    const tenant = dock.subject.principal?.tenant;
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
    return grants.some((grant) => grant.effect === 'allow');
  } catch {
    return false;
  }
}
