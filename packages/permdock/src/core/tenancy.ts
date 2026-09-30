import type { ResourceNode } from './permissions.ts';
import type { GrantScope } from './policy.ts';
import type { Membership, Principal, Subject } from './subject.ts';

import { isFieldRelation } from './permissions.ts';
import {
  type Scope,
  activeFor,
  findScope,
  resolveScope,
  rootScope,
  scopeChain,
  scopeIdOf,
  tenantOf,
} from './scopes.ts';

export { activeFor };

export function nowSeconds(now?: number): number {
  return now ?? Date.now() / 1000;
}

export function isMembershipExpired(
  membership: Membership,
  now: number,
): boolean {
  return membership.expiresAt !== undefined && membership.expiresAt <= now;
}

/** The instances of the first scope the subject holds any membership in. */
export function tenantsOf(
  principal: Principal | null,
  scopes: readonly Scope[],
): readonly string[] {
  if (principal === null) {
    return [];
  }
  const tenants = new Set<string>();
  for (const membership of principal.memberships ?? []) {
    const tenant = tenantOf(membership, scopes);
    if (tenant !== undefined) {
      tenants.add(tenant);
    }
  }
  return [...tenants];
}

/** `requested` when a membership sits in that instance of the first scope; never a default. */
export function resolveActiveTenant(
  principal: Principal,
  requested: string | undefined,
  scopes: readonly Scope[],
): string | undefined {
  if (requested === undefined) {
    return principal.tenant;
  }
  const memberships = principal.memberships ?? [];
  const match = memberships.some(
    (membership) => tenantOf(membership, scopes) === requested,
  );
  return match ? requested : undefined;
}

/** `permdock.team(id)`: only memberships inside that instance of the second scope. */
export function inTeam(
  membership: Membership,
  scopes: readonly Scope[],
  team: string | undefined,
): boolean {
  if (team === undefined) {
    return true;
  }
  const second = scopes[1]?.name;
  return second !== undefined && scopeIdOf(membership, second) === team;
}

/**
 * Whether `resource` declares a `memberOf` relation to `scope` on `field`:
 * its rows are partitioned by that scope, so a row without the field matches
 * no membership.
 */
export function relatesTo(
  resource: ResourceNode | undefined,
  field: string,
  scope: string,
  scopes: readonly Scope[],
): boolean {
  if (resource === undefined) {
    return false;
  }
  return Object.values(resource.relations).some(
    (relation) =>
      isFieldRelation(relation) &&
      relation.field === field &&
      relation.memberOf !== undefined &&
      resolveScope(scopes, relation.memberOf) === scope,
  );
}

/** The scopes whose key partitions `resource`, from its `memberOf` relations. */
export function partitionsOf(
  resource: ResourceNode,
  scopes: readonly Scope[],
): readonly string[] {
  return scopes
    .filter(
      (scope) =>
        scope.key !== undefined &&
        relatesTo(resource, scope.key, scope.name, scopes),
    )
    .map((scope) => scope.name);
}

export type RowScope =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'tenant-mismatch' | 'scope' };

/**
 * Whether `row` lies inside a named membership's instance: for the scope and
 * each ancestor, outermost first, a row that carries the scope's key (or whose
 * resource declares it) must hold the membership's id for it. There is no
 * cascade: the membership's own scope is checked, never a scope below it.
 */
export function rowInScope(
  membership: Membership,
  scopes: readonly Scope[],
  row: unknown,
  partitioned: (scope: string, key: string) => boolean,
): RowScope {
  if (
    membership.scope === undefined ||
    row === null ||
    typeof row !== 'object'
  ) {
    return { ok: true };
  }
  const root = rootScope(scopes);
  const chain = scopeChain(scopes, membership.scope).toReversed();
  for (const name of chain) {
    const key = findScope(scopes, name)?.key;
    if (key === undefined) {
      continue;
    }
    // SAFETY: row is a non-null object checked above and key is its own property; value stays unknown.
    const value = Object.hasOwn(row, key)
      ? (row as Record<string, unknown>)[key]
      : undefined;
    if (
      (value !== undefined || partitioned(name, key)) &&
      value !== scopeIdOf(membership, name)
    ) {
      return {
        ok: false,
        reason: name === root ? 'tenant-mismatch' : 'scope',
      };
    }
  }
  return { ok: true };
}

export type ScopeMatch =
  | { readonly ok: true; readonly membership?: Membership }
  | {
      readonly ok: false;
      readonly reason:
        | 'tenant-mismatch'
        | 'no-membership'
        | 'scope'
        | 'expired-membership'
        | 'relation-depth'
        | 'relation-unavailable';
    };

/** Whether a resource-role membership reaches the row through the self-parent chain. */
export type ResourceRoleWalk = (
  membership: Membership,
  row: unknown,
) => boolean | 'relation-depth' | 'relation-unavailable';

export function matchScopedMembership(
  subject: Subject,
  scope: GrantScope,
  roleName: string,
  row: unknown,
  scopes: readonly Scope[],
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
  now: number,
  rolesOf: (membership: Membership) => readonly string[] = (membership) =>
    membership.roles,
  team?: string,
  walk?: ResourceRoleWalk,
): ScopeMatch {
  if (scope === 'global') {
    return { ok: true };
  }
  const principal = subject.principal;
  if (principal === null) {
    return { ok: false, reason: 'no-membership' };
  }
  const memberships = principal.memberships ?? [];
  const root = rootScope(scopes);
  let sawExpired = false;
  let sawWrongScope = false;
  let sawTenantMismatch = false;
  let sawGraph: 'relation-depth' | 'relation-unavailable' | undefined;
  for (const membership of memberships) {
    if (!rolesOf(membership).includes(roleName)) {
      continue;
    }
    if (isMembershipExpired(membership, now)) {
      sawExpired = true;
      continue;
    }
    if (typeof scope === 'string') {
      if (
        findScope(scopes, scope) === undefined ||
        membership.scope !== scope ||
        !inTeam(membership, scopes, team) ||
        !activeFor(membership, scopes, principal.tenant)
      ) {
        continue;
      }
      const inside = rowInScope(membership, scopes, row, (name, key) =>
        relatesTo(resource, key, name, scopes),
      );
      if (!inside.ok) {
        if (inside.reason === 'tenant-mismatch') {
          sawTenantMismatch = true;
        } else {
          sawWrongScope = true;
        }
        continue;
      }
      return { ok: true, membership };
    }
    if (membership.on === undefined) {
      continue;
    }
    if (
      matchResourceMembership(
        membership,
        scope.resource,
        row,
        resource,
        resources,
      )
    ) {
      return { ok: true, membership };
    }
    const walked =
      walk !== undefined &&
      (membership.on.resource === scope.resource ||
        membershipField(
          resources.get(scope.resource),
          membership.on.resource,
          resources,
        ) !== undefined)
        ? walk(membership, row)
        : false;
    if (walked === true) {
      return { ok: true, membership };
    }
    if (walked !== false) {
      sawGraph ??= walked;
    }
    sawWrongScope = true;
  }
  if (sawGraph !== undefined) {
    return { ok: false, reason: sawGraph };
  }
  if (
    scope === root &&
    principal.tenant !== undefined &&
    !memberships.some(
      (membership) =>
        tenantOf(membership, scopes) === principal.tenant &&
        !isMembershipExpired(membership, now),
    )
  ) {
    return { ok: false, reason: 'no-membership' };
  }
  if (sawTenantMismatch) {
    return { ok: false, reason: 'tenant-mismatch' };
  }
  if (sawExpired && !sawWrongScope) {
    return { ok: false, reason: 'expired-membership' };
  }
  if (sawWrongScope) {
    return { ok: false, reason: 'scope' };
  }
  return { ok: false, reason: 'no-membership' };
}

function matchResourceMembership(
  membership: Membership,
  roleResource: string,
  row: unknown,
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
): boolean {
  const on = membership.on;
  if (on === undefined) {
    /* v8 ignore next */
    return false;
  }
  if (row === null || typeof row !== 'object') {
    return false;
  }
  if (
    on.resource !== roleResource &&
    membershipField(resources.get(roleResource), on.resource, resources) ===
      undefined
  ) {
    return false;
  }
  const field = membershipField(resource, on.resource, resources);
  // SAFETY: row is a non-null object checked above; the read value is only compared with on.id.
  return (
    field !== undefined && (row as Record<string, unknown>)[field] === on.id
  );
}

/**
 * The row field that holds the id of a `membershipResource` membership: the
 * row's own id field when the row is of that resource, the declared parent
 * field of the matching ancestor otherwise (the row carries it, never a
 * walk-up query), `undefined` when the resource is not on the row's chain.
 */
export function membershipField(
  resource: ResourceNode | undefined,
  membershipResource: string,
  resources: ReadonlyMap<string, ResourceNode>,
): string | undefined {
  if (resource === undefined) {
    return undefined;
  }
  if (resource.name === membershipResource) {
    return resource.id ?? 'id';
  }
  let current: ResourceNode | undefined = resource;
  const seen = new Set<string>();
  while (current?.parent !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    if (current.parent.resource === membershipResource) {
      return current.parent.field;
    }
    current = resources.get(current.parent.resource);
  }
  return undefined;
}
