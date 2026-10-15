import type { Policy, RoleBinding } from "./policy-types.ts";
import type { Membership } from "./subject.ts";

import { freezeDeep } from "./freeze.ts";
import { isExternallyManaged } from "./memberships.ts";
import { type RoleMeta, findRole, listRoles } from "./vocabulary.ts";

export function bindingOf(
  policy: Policy,
  name: string,
): RoleBinding | undefined {
  return policy.rolesByName.get(name);
}

export function roleMeta(policy: Policy, name: string): RoleMeta | undefined {
  return (
    bindingOf(policy, name)?.meta ??
    findRole(policy.vocabulary?.roles, name)?.meta
  );
}

/** A role with `for` is held only through a membership of one of those kinds. */
function mayHoldVia(
  policy: Policy,
  role: string,
  via: string | undefined,
): boolean {
  const kinds = bindingOf(policy, role)?.for;
  return kinds === undefined || (via !== undefined && kinds.includes(via));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The identity provider may only hand out what the application could: a
 * declared role with `assignable: false` (an owner, a platform role) never
 * rides in on a `managedBy: 'idp'` membership. A name the policy does not
 * declare stays, because only a tenant's custom role can give it meaning.
 */
function mayHoldManaged(
  policy: Policy,
  role: string,
  membership: Membership,
): boolean {
  return (
    !isExternallyManaged(membership) ||
    bindingOf(policy, role)?.assignable !== false
  );
}

/**
 * Drops every role a membership's kind may not hold (fail-closed: a missing
 * `via` is no kind) and every non-assignable role on an identity-provider
 * membership. Global roles have no kind, so a role with `for` held globally
 * is dropped too.
 */
export function applyRoleKinds(
  policy: Policy,
  roles: readonly string[] | undefined,
  memberships: readonly Membership[],
): {
  readonly roles: readonly string[] | undefined;
  readonly memberships: readonly Membership[];
} {
  const kinds = policy.roles.some((binding) => binding.for !== undefined);
  if (!kinds && !memberships.some(isExternallyManaged)) {
    return { roles, memberships };
  }
  const kept = kinds
    ? (roles?.filter((name) => mayHoldVia(policy, name, undefined)) ?? roles)
    : roles;
  const filtered = memberships.map((membership) => {
    const allowed = membership.roles.filter(
      (name) =>
        mayHoldVia(policy, name, membership.via) &&
        mayHoldManaged(policy, name, membership),
    );
    return sameList(allowed, membership.roles)
      ? membership
      : freezeDeep({ ...membership, roles: allowed });
  });
  return { roles: kept, memberships: filtered };
}

export function usesAssigns(policy: Policy): boolean {
  return policy.roles.some((binding) => binding.assigns !== undefined);
}

/** Declared role names in declaration order: bindings first, then vocabulary-only leaves. */
function declarationOrder(policy: Policy): readonly string[] {
  const names = policy.roles.map((binding) => binding.name);
  const seen = new Set(names);
  for (const leaf of listRoles(policy.vocabulary?.roles)) {
    if (!seen.has(leaf.key)) {
      names.push(leaf.key);
      seen.add(leaf.key);
    }
  }
  return names;
}

/**
 * Each role's depth in the `assigns` graph: a role nobody else assigns is 0,
 * a role another assigns sits one below its deepest assigner. Cycles stop
 * after one pass per role.
 */
function assignDepths(policy: Policy): ReadonlyMap<string, number> {
  const names = declarationOrder(policy);
  const depth = new Map(names.map((name) => [name, 0]));
  for (let pass = 0; pass < names.length; pass += 1) {
    let changed = false;
    for (const binding of policy.roles) {
      const from = depth.get(binding.name) ?? 0;
      for (const target of binding.assigns ?? []) {
        if (target !== binding.name && (depth.get(target) ?? 0) < from + 1) {
          depth.set(target, from + 1);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return depth;
}

/**
 * `names` ordered by rank: assigners before the roles they assign, then
 * declaration order. Without an `assigns` graph the order is kept.
 */
export function rankRoles(
  policy: Policy,
  names: readonly string[],
): readonly string[] {
  if (!usesAssigns(policy)) {
    return names;
  }
  const order = declarationOrder(policy);
  const depth = assignDepths(policy);
  const index = (name: string): number => {
    const found = order.indexOf(name);
    return found === -1 ? order.length : found;
  };
  return [...names].toSorted(
    (a, b) =>
      (depth.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (depth.get(b) ?? Number.MAX_SAFE_INTEGER) || index(a) - index(b),
  );
}

/** The distinct `meta.audience` values of `names`, in rank order. */
export function audiencesOf(
  policy: Policy,
  names: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const name of rankRoles(policy, names)) {
    const audience = roleMeta(policy, name)?.audience;
    if (typeof audience === "string" && !out.includes(audience)) {
      out.push(audience);
    }
  }
  return out;
}

/** Whether `membership` is the instance itself or one of its ancestors named in `within`. */
