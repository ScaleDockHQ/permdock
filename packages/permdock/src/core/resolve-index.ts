import type { Grant, PolicyVocabulary, RoleBinding } from "./policy-types.ts";

import { flattenGrantee } from "./grantee.ts";
import { findRole } from "./vocabulary.ts";

/** The one declared role a grant names, or `undefined` for none or several. */
export function soleRole(grant: Grant): string | undefined {
  const roles = flattenGrantee(grant.to).filter((item) => item.kind === "role");
  const first = roles[0];
  return roles.length === 1 && first?.kind === "role" ? first.role : undefined;
}

/**
 * What every custom-role resolution of one policy shares, built with the policy
 * so a resolution never rescans the grant list.
 */
export type ResolveIndex = {
  /** Allows of assignable declared roles by scope name: the custom-role ceiling. */
  readonly ceilings: ReadonlyMap<string, readonly Grant[]>;
  readonly ceilingSets: ReadonlyMap<string, ReadonlySet<Grant>>;
  readonly ceilingKeys: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every grant that is not hosted. */
  readonly all: readonly Grant[];
  /** The non-hosted grants whose grantee is exactly one role, by role name. */
  readonly byRole: ReadonlyMap<string, readonly Grant[]>;
};

function isAssignable(
  roles: readonly RoleBinding[],
  vocabulary: PolicyVocabulary,
  name: string,
): boolean {
  const binding = roles.find((item) => item.name === name);
  return binding === undefined
    ? findRole(vocabulary.roles, name)?.assignable === true
    : binding.assignable;
}

export function buildResolveIndex(
  roles: readonly RoleBinding[],
  listed: readonly Grant[],
  vocabulary: PolicyVocabulary,
): ResolveIndex {
  const all = listed.filter((grant) => grant.hosted === undefined);
  const byRole = new Map<string, Grant[]>();
  const ceilings = new Map<string, Grant[]>();
  const assignable = new Map<string, boolean>();
  for (const grant of all) {
    const name = soleRole(grant);
    if (name === undefined) {
      continue;
    }
    const roleGrants = byRole.get(name) ?? [];
    roleGrants.push(grant);
    byRole.set(name, roleGrants);
    if (grant.effect !== "allow" || typeof grant.scope !== "string") {
      continue;
    }
    let reach = assignable.get(name);
    if (reach === undefined) {
      reach = isAssignable(roles, vocabulary, name);
      assignable.set(name, reach);
    }
    if (reach) {
      const list = ceilings.get(grant.scope) ?? [];
      list.push(grant);
      ceilings.set(grant.scope, list);
    }
  }
  const ceilingSets = new Map<string, ReadonlySet<Grant>>();
  const ceilingKeys = new Map<string, ReadonlySet<string>>();
  for (const [scope, list] of ceilings) {
    ceilingSets.set(scope, new Set(list));
    ceilingKeys.set(scope, new Set(list.map((grant) => grant.permission.key)));
  }
  return { ceilings, ceilingSets, ceilingKeys, all, byRole };
}
