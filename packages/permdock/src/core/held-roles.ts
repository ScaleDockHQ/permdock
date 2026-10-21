import type { Policy } from "./policy-types.ts";
import type { Subject } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { compact } from "./compact.ts";
import { sameId } from "./ids.ts";
import { rankRoles } from "./role-rank.ts";
import { resolveScope, scopeList, tenantOf } from "./scopes.ts";
import { isMembershipExpired } from "./tenancy.ts";
import { findRole, synthesiseRole } from "./vocabulary.ts";

/**
 * Role names held in `tenant` on live memberships, global roles included, in
 * rank order. With `scope`, only the roles of that scope's memberships (and
 * instance `id`).
 */
export function heldRoleNames(
  policy: Policy,
  subject: Subject,
  tenant?: string,
  only?: { readonly scope?: string; readonly id?: string },
  now?: number,
): readonly string[] {
  if (subject.principal === null) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const scope =
    only?.scope === undefined ? undefined : resolveScope(scopes, only.scope);
  if (only?.scope !== undefined && scope === undefined) {
    return [];
  }
  const names = new Set<string>(
    scope === undefined ? (subject.principal.roles ?? []) : [],
  );
  for (const membership of subject.principal.memberships ?? []) {
    if (isMembershipExpired(membership, now) || membership.keep !== undefined) {
      continue;
    }
    const matches =
      scope === undefined
        ? tenantOf(membership, scopes) === tenant
        : membership.scope === scope &&
          (only?.id === undefined || sameId(membership.id, only.id));
    if (!matches) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return rankRoles(policy, [...names]);
}

export function roleLeaf(policy: Policy, name: string): Role {
  const binding = policy.rolesByName.get(name);
  return (
    findRole(policy.vocabulary?.roles, name) ??
    synthesiseRole(
      name,
      compact({
        on: typeof binding?.on === "string" ? binding.on : undefined,
        assignable: binding?.assignable,
        meta: binding?.meta,
      }),
    )
  );
}
