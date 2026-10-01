import type { DenialReason } from './decision.ts';
import type { Permission } from './permissions.ts';
import type { Delegation, GnapAccess } from './subject.ts';

type DelegatedPermission = Pick<Permission, 'scope' | 'resource' | 'action'>;

/**
 * Whether a delegated caller may use a permission its principal holds, through
 * OAuth `scopes`, RFC 9396 `authorizationDetails` or GNAP `access`.
 * `undefined` means covered; otherwise the denial reason `decide` would add.
 */
export function coveredByDelegation(
  permission: DelegatedPermission,
  delegation: Delegation | undefined,
  resourceId?: string,
  hasActor = false,
): DenialReason | undefined {
  const unscoped = hasActor ? 'no-delegation' : undefined;
  if (delegation === undefined) {
    return unscoped;
  }
  const hasScopes = delegation.scopes !== undefined;
  const hasDetails = delegation.authorizationDetails !== undefined;
  const hasAccess = delegation.access !== undefined;
  if (!hasScopes && !hasDetails && !hasAccess) {
    return unscoped;
  }
  const emptyScopes = hasScopes && (delegation.scopes?.length ?? 0) === 0;
  const emptyAccess = hasAccess && (delegation.access?.length ?? 0) === 0;
  if (emptyScopes && !hasDetails && !hasAccess) {
    return 'no-delegation';
  }
  if (emptyAccess && !hasScopes && !hasDetails) {
    return 'no-delegation';
  }
  if (emptyScopes && emptyAccess && !hasDetails) {
    return 'no-delegation';
  }
  const scopeOk = delegation.scopes?.includes(permission.scope) ?? false;
  const detailOk =
    delegation.authorizationDetails?.some((detail) => {
      if (detail.type !== permission.resource) {
        return false;
      }
      const identifier: unknown = detail['identifier'];
      if (
        identifier !== undefined &&
        (typeof identifier !== 'string' || identifier !== resourceId)
      ) {
        return false;
      }
      const actions: unknown = detail.actions;
      if (actions === undefined) {
        return true;
      }
      return Array.isArray(actions) && actions.includes(permission.action);
    }) ?? false;
  const accessOk = accessCovers(permission, delegation.access, resourceId);
  if (scopeOk || detailOk || accessOk) {
    return undefined;
  }
  return 'not-delegated';
}

function accessCovers(
  permission: DelegatedPermission,
  access: readonly GnapAccess[] | undefined,
  resourceId: string | undefined,
): boolean {
  if (access === undefined) {
    return false;
  }
  return access.some((entry) => {
    if (typeof entry === 'string') {
      return entry === permission.scope;
    }
    if (entry === null || typeof entry !== 'object') {
      return false;
    }
    const type = entry['type'];
    if (typeof type !== 'string' || !typeMatches(type, permission.resource)) {
      return false;
    }
    // A present field of the wrong type narrows nothing, so it covers nothing.
    const actions = entry['actions'];
    if (
      actions !== undefined &&
      (!Array.isArray(actions) || !actions.includes(permission.action))
    ) {
      return false;
    }
    const identifier = entry['identifier'];
    if (
      identifier !== undefined &&
      (typeof identifier !== 'string' || identifier !== resourceId)
    ) {
      return false;
    }
    return true;
  });
}

function typeMatches(type: string, resource: string): boolean {
  if (type === resource) {
    return true;
  }
  return type.endsWith(`/${resource}`);
}

export function resourceIdOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object' || !('id' in data)) {
    return undefined;
  }
  const id = data.id;
  return typeof id === 'string' || typeof id === 'number'
    ? String(id)
    : undefined;
}
