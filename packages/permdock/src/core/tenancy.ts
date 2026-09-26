import type { ResourceNode } from './permissions.ts';
import type { Membership, Principal, Subject } from './subject.ts';

export function nowSeconds(now?: number): number {
  return now ?? Date.now() / 1000;
}

export function isMembershipExpired(
  membership: Membership,
  now: number,
): boolean {
  return membership.expiresAt !== undefined && membership.expiresAt <= now;
}

export function membershipScopeKind(
  membership: Membership,
): 'tenant' | 'team' | 'resource' | 'invalid' {
  const hasOn = membership.on !== undefined;
  const hasTeam = membership.team !== undefined;
  const hasTenant = membership.tenant !== undefined;
  if (hasOn && !hasTeam && !hasTenant) {
    return 'resource';
  }
  if (hasTeam && hasTenant && !hasOn) {
    return 'team';
  }
  if (hasTenant && !hasTeam && !hasOn) {
    return 'tenant';
  }
  return 'invalid';
}

export function tenantsOf(principal: Principal | null): readonly string[] {
  if (principal === null) {
    return [];
  }
  const tenants = new Set<string>();
  for (const membership of principal.memberships ?? []) {
    if (membership.tenant !== undefined) {
      tenants.add(membership.tenant);
    }
  }
  return [...tenants];
}

export function resolveActiveTenant(
  principal: Principal,
  requested: string | undefined,
): string | undefined {
  if (requested === undefined) {
    return principal.tenant;
  }
  const memberships = principal.memberships ?? [];
  const match = memberships.some(
    (membership) => membership.tenant === requested,
  );
  return match ? requested : undefined;
}

/**
 * Whether `resource` declares a `memberOf` relation on `field`: its rows are
 * partitioned by that scope, so a row without the field matches no membership.
 */
export function relatesTo(
  resource: ResourceNode | undefined,
  field: string,
  memberOf: 'tenant' | 'team',
): boolean {
  if (resource === undefined) {
    return false;
  }
  return Object.values(resource.relations).some(
    (relation) => relation.field === field && relation.memberOf === memberOf,
  );
}

export type ScopeMatch =
  | { readonly ok: true; readonly membership?: Membership }
  | {
      readonly ok: false;
      readonly reason:
        | 'tenant-mismatch'
        | 'no-membership'
        | 'scope'
        | 'expired-membership';
    };

export function matchScopedMembership(
  subject: Subject,
  scope: 'global' | 'tenant' | 'team' | { readonly resource: string },
  roleName: string,
  row: unknown,
  scopes: {
    readonly tenant?: { readonly key: string };
    readonly team?: { readonly key: string };
  },
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
  now: number,
  rolesOf: (membership: Membership) => readonly string[] = (membership) =>
    membership.roles,
): ScopeMatch {
  if (scope === 'global') {
    return { ok: true };
  }
  const principal = subject.principal;
  if (principal === null) {
    return { ok: false, reason: 'no-membership' };
  }
  const memberships = principal.memberships ?? [];
  let sawExpired = false;
  let sawWrongScope = false;
  let sawTenantMismatch = false;
  for (const membership of memberships) {
    if (!rolesOf(membership).includes(roleName)) {
      continue;
    }
    if (isMembershipExpired(membership, now)) {
      sawExpired = true;
      continue;
    }
    const kind = membershipScopeKind(membership);
    if (kind === 'invalid') {
      continue;
    }
    if (scope === 'tenant') {
      if (kind !== 'tenant' && kind !== 'team') {
        continue;
      }
      const active = principal.tenant;
      if (active === undefined || membership.tenant !== active) {
        continue;
      }
      if (
        row !== null &&
        typeof row === 'object' &&
        scopes.tenant !== undefined
      ) {
        const rowTenant = (row as Record<string, unknown>)[scopes.tenant.key];
        const partitioned =
          rowTenant !== undefined ||
          relatesTo(resource, scopes.tenant.key, 'tenant');
        if (partitioned && rowTenant !== membership.tenant) {
          sawTenantMismatch = true;
          continue;
        }
      }
      return { ok: true, membership };
    }
    if (scope === 'team') {
      if (kind !== 'team') {
        continue;
      }
      const active = principal.tenant;
      if (active === undefined || membership.tenant !== active) {
        continue;
      }
      if (
        row !== null &&
        typeof row === 'object' &&
        scopes.team !== undefined
      ) {
        const rowTeam = (row as Record<string, unknown>)[scopes.team.key];
        const partitioned =
          rowTeam !== undefined || relatesTo(resource, scopes.team.key, 'team');
        if (partitioned && rowTeam !== membership.team) {
          sawWrongScope = true;
          continue;
        }
      }
      return { ok: true, membership };
    }
    if (kind !== 'resource' || membership.on === undefined) {
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
    sawWrongScope = true;
  }
  if (scope === 'tenant' && principal.tenant !== undefined) {
    const belongs = memberships.some(
      (membership) =>
        membership.tenant === principal.tenant &&
        !isMembershipExpired(membership, now),
    );
    if (!belongs) {
      return { ok: false, reason: 'no-membership' };
    }
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
