import type { DenialReason } from "./decision.ts";
import type { PolicyDelegation } from "./policy.ts";
import type { Delegation, GnapAccess, Subject } from "./subject.ts";

import { flattenGrantee, matchGrantee } from "./grantee.ts";
import { type Permission, formerScopes } from "./permissions.ts";
import { isActive } from "./validity.ts";

type DelegatedPermission = Pick<Permission, "scope" | "resource" | "action">;

/** The permission's scope and any scope it was renamed from: tokens issued before a rename keep working. */
function scopeNames(permission: DelegatedPermission): readonly string[] {
  return [permission.scope, ...formerScopes(permission)];
}

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
  const unscoped = hasActor ? "no-delegation" : undefined;
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
    return "no-delegation";
  }
  if (emptyAccess && !hasScopes && !hasDetails) {
    return "no-delegation";
  }
  if (emptyScopes && emptyAccess && !hasDetails) {
    return "no-delegation";
  }
  const scopes = scopeNames(permission);
  const scopeOk =
    delegation.scopes?.some((scope) => scopes.includes(scope)) ?? false;
  const detailOk =
    delegation.authorizationDetails?.some((detail) => {
      if (detail.type !== permission.resource) {
        return false;
      }
      const identifier: unknown = detail["identifier"];
      if (
        identifier !== undefined &&
        (typeof identifier !== "string" || identifier !== resourceId)
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
  return "not-delegated";
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
    if (typeof entry === "string") {
      return scopeNames(permission).includes(entry);
    }
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const type = entry["type"];
    if (typeof type !== "string" || !typeMatches(type, permission.resource)) {
      return false;
    }
    // A present field of the wrong type narrows nothing, so it covers nothing.
    const actions = entry["actions"];
    if (
      actions !== undefined &&
      (!Array.isArray(actions) || !actions.includes(permission.action))
    ) {
      return false;
    }
    const identifier = entry["identifier"];
    if (
      identifier !== undefined &&
      (typeof identifier !== "string" || identifier !== resourceId)
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
  if (data === null || typeof data !== "object" || !("id" in data)) {
    return undefined;
  }
  const id = data.id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

/**
 * Whether the subject's principal is a `from` of the delegation: every item
 * matches, with roles checked against the roles the principal holds here
 * (`matchGrantee` leaves role holding to the caller) and nothing that needs a
 * row.
 */
function handsOver(
  delegation: PolicyDelegation,
  subject: Subject,
  heldRoles: ReadonlySet<string>,
  now: number,
): boolean {
  const items = flattenGrantee(delegation.from);
  if (items.length === 0 || subject.principal === null) {
    return false;
  }
  return items.every((item) => {
    if (item.kind === "role") {
      return heldRoles.has(item.role);
    }
    if (item.kind === "relation") {
      return false;
    }
    const match = matchGrantee(item, subject, now, undefined);
    return match.matched && match.where === undefined;
  });
}

/**
 * The permission keys the policy's delegations let `subject.actor` use for
 * `subject.principal` right now: the union over every active delegation whose
 * `to` matches the actor and whose `from` the principal holds. `undefined`
 * when none applies, so the call falls back to the token delegation alone.
 * An actor with `readOnly: true` gets only each delegation's read-only keys.
 * Attenuation only: a key here still needs a matching allow and no deny.
 */
export function delegatedPermissions(
  delegations: readonly PolicyDelegation[] | undefined,
  subject: Subject,
  heldRoles: ReadonlySet<string>,
  now: number,
): ReadonlySet<string> | undefined {
  const actor = subject.actor;
  if (actor === undefined || delegations === undefined) {
    return undefined;
  }
  let keys: Set<string> | undefined;
  for (const delegation of delegations) {
    if (
      delegation.to.kind !== actor.kind ||
      (delegation.to.id !== undefined && delegation.to.id !== actor.id) ||
      (delegation.to.client !== undefined &&
        delegation.to.client !== actor.client) ||
      !isActive(delegation.validity, now) ||
      !handsOver(delegation, subject, heldRoles, now)
    ) {
      continue;
    }
    keys ??= new Set<string>();
    for (const key of actor.readOnly === true
      ? delegation.readOnly
      : delegation.permissions) {
      keys.add(key);
    }
  }
  return keys;
}
