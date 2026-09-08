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
  now: number,
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
    if (!membership.roles.includes(roleName)) {
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
        if (rowTenant !== undefined && rowTenant !== membership.tenant) {
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
        if (rowTeam !== undefined && rowTeam !== membership.team) {
          sawWrongScope = true;
          continue;
        }
      }
      return { ok: true, membership };
    }
    if (kind !== 'resource' || membership.on === undefined) {
      continue;
    }
    if (matchResourceMembership(membership, scope.resource, row, resource)) {
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
  resourceName: string,
  row: unknown,
  resource: ResourceNode | undefined,
): boolean {
  const on = membership.on;
  if (on === undefined) {
    /* v8 ignore next */
    return false;
  }
  if (row === null || typeof row !== 'object') {
    return false;
  }
  const record = row as Record<string, unknown>;
  if (on.resource === resourceName) {
    const idField = resource?.id ?? 'id';
    return record[idField] === on.id;
  }
  if (
    resource?.parent !== undefined &&
    on.resource === resource.parent.resource
  ) {
    return record[resource.parent.field] === on.id;
  }
  return false;
}

export function parentFieldChain(
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
): readonly string[] {
  const fields: string[] = [];
  let current = resource;
  const seen = new Set<string>();
  while (current?.parent !== undefined) {
    if (seen.has(current.name)) {
      break;
    }
    seen.add(current.name);
    fields.push(current.parent.field);
    current = resources.get(current.parent.resource);
  }
  return fields;
}
