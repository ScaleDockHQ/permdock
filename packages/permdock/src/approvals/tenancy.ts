import type { Subject } from "../core/subject.ts";

import { rootMembershipId } from "../core/scopes.ts";

/**
 * The tenants a subject acts in for approvals: `principal.tenant` and the
 * instance of every membership at the first scope. A membership at a nested
 * scope (a team, or one with `within`) names no tenant, even when its parent
 * is the request's tenant.
 */
export function membershipTenants(subject: Subject): readonly string[] {
  const principal = subject.principal;
  if (principal === null) {
    return [];
  }
  const tenants = new Set<string>();
  if (principal.tenant !== undefined) {
    tenants.add(principal.tenant);
  }
  for (const membership of principal.memberships ?? []) {
    const tenant = rootMembershipId(membership);
    if (tenant !== undefined) {
      tenants.add(tenant);
    }
  }
  return [...tenants];
}

export function belongsToTenant(subject: Subject, tenant: string): boolean {
  return membershipTenants(subject).includes(tenant);
}
