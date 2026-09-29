import type { Snapshot } from './interfaces.ts';
import type { Principal, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { type Scope, resolveScope, scopeList, tenantOf } from './scopes.ts';
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

/**
 * Role names held in `tenant`, or only on memberships of one `scope` (and
 * instance `id`), ordered like `rank` (the snapshot's ranked `roles`).
 */
export function heldRoleNames(
  subject: Subject,
  tenant: string | undefined,
  scopes: readonly Scope[],
  only?: {
    readonly scope?: string;
    readonly id?: string;
    readonly rank?: readonly string[];
  },
): string[] {
  const scope =
    only?.scope === undefined ? undefined : resolveScope(scopes, only.scope);
  if (only?.scope !== undefined && scope === undefined) {
    return [];
  }
  const names = new Set<string>(
    scope === undefined ? (subject.principal?.roles ?? []) : [],
  );
  for (const membership of subject.principal?.memberships ?? []) {
    const matches =
      scope === undefined
        ? tenantOf(membership, scopes) === tenant
        : membership.scope === scope &&
          (only?.id === undefined || membership.id === only.id);
    if (!matches) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  const rank = only?.rank ?? [];
  const position = (name: string): number => {
    const index = rank.indexOf(name);
    return index === -1 ? rank.length : index;
  };
  return [...names].toSorted((a, b) => position(a) - position(b));
}
