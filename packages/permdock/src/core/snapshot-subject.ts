import type { Snapshot } from './interfaces.ts';
import type { Principal, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { type Scope, scopeList, tenantOf } from './scopes.ts';
import { resolveActiveTenant } from './tenancy.ts';

export function subjectFromSnapshot(
  snapshot: Snapshot,
  tenant: string | undefined,
): Subject {
  const principal = snapshot.subject.principal;
  const nextTenant =
    principal === null
      ? undefined
      : tenant === undefined
        ? principal.tenant
        : resolveActiveTenant(
            compact<Principal>({
              ...principal,
              memberships: principal.memberships ?? [],
            }),
            tenant,
            scopeList(snapshot.scopes),
          );
  return freezeDeep(
    compact<Subject>({
      principal:
        principal === null
          ? null
          : compact<Principal>({
              ...principal,
              tenant: nextTenant,
            }),
      delegation: snapshot.subject.delegation,
      context: snapshot.subject.context,
      expiresAt: snapshot.expiresAt,
    }),
  );
}

export function heldRoleNames(
  subject: Subject,
  tenant: string | undefined,
  scopes: readonly Scope[],
): string[] {
  const names = new Set<string>(subject.principal?.roles ?? []);
  for (const membership of subject.principal?.memberships ?? []) {
    if (tenantOf(membership, scopes) !== tenant) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return [...names];
}
