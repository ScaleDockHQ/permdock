import type { RoleGrantee } from './grantee.ts';
import type { Grant, Policy } from './policy.ts';
import type { CustomRole, Membership } from './subject.ts';

import { freezeDeep } from './freeze.ts';
import { flattenGrantee } from './grantee.ts';
import { findPermission } from './permissions.ts';
import { declaredRoleNames, grantList } from './policy.ts';
import { findRole } from './vocabulary.ts';

export type CustomRoleDropReason =
  | 'unknown-permission'
  | 'outside-ceiling'
  | 'condition-not-allowed';

/** Why part of a custom role was left out: a permission, or an undeclared include. */
export type CustomRoleDrop =
  | { readonly permission: string; readonly reason: CustomRoleDropReason }
  | { readonly role: string; readonly reason: 'unknown-role' };

export type ResolvedCustomRole = {
  /** Declared grants re-targeted to the custom role; conditions and approvals kept. */
  readonly grants: readonly Grant[];
  readonly dropped: readonly CustomRoleDrop[];
};

export type CustomRoleValidation = {
  readonly ok: boolean;
  /** Permission keys the role allows after the ceiling, sorted. */
  readonly permissions: readonly string[];
  readonly dropped: readonly CustomRoleDrop[];
};

/** A resolved custom-role grant and the role it belongs to. */
export type CustomGrant = {
  readonly grant: Grant;
  readonly role: CustomRole;
};

const GRANT_KEYS = new Set(['permission', 'effect']);

export function customRoleScope(
  role: Pick<CustomRole, 'team'>,
): 'tenant' | 'team' {
  return role.team === undefined ? 'tenant' : 'team';
}

function soleRole(grant: Grant): string | undefined {
  const roles = flattenGrantee(grant.to).filter((item) => item.kind === 'role');
  const first = roles[0];
  return roles.length === 1 && first?.kind === 'role' ? first.role : undefined;
}

/** Permission keys a declared role's allows reach, hosted grants included. */
export function roleAllowKeys(
  policy: Policy,
  name: string,
): ReadonlySet<string> {
  return new Set(
    grantList(policy)
      .filter((grant) => grant.effect === 'allow' && soleRole(grant) === name)
      .map((grant) => grant.permission.key),
  );
}

export function isAssignableRole(policy: Policy, name: string): boolean {
  const binding = policy.rolesByName.get(name);
  if (binding !== undefined) {
    return binding.assignable;
  }
  return findRole(policy.vocabulary?.roles, name)?.assignable === true;
}

/**
 * The code allows of declared `assignable` roles in `scope`: everything a
 * custom role of that scope may ever reach. Hosted grants never widen it.
 * `assignable` narrows it to those role names (`RoleSource.assignable`).
 */
export function ceilingGrants(
  policy: Policy,
  scope: 'tenant' | 'team',
  assignable?: readonly string[],
): readonly Grant[] {
  const allowed = assignable === undefined ? undefined : new Set(assignable);
  return grantList(policy).filter((grant) => {
    const name = soleRole(grant);
    return (
      grant.effect === 'allow' &&
      grant.hosted === undefined &&
      grant.scope === scope &&
      name !== undefined &&
      isAssignableRole(policy, name) &&
      (allowed === undefined || allowed.has(name))
    );
  });
}

function retarget(
  grant: Grant,
  role: CustomRole,
  scope: 'tenant' | 'team',
): Grant {
  const grantee: RoleGrantee = { kind: 'role', role: role.name, scope };
  const others = flattenGrantee(grant.to).filter(
    (item) => item.kind !== 'role',
  );
  return freezeDeep({
    ...grant,
    to: others.length === 0 ? grantee : [grantee, ...others],
    role: role.name,
    scope,
  });
}

/**
 * The one resolver behind evaluation, snapshots and `validateCustomRole`.
 * Included roles' grants plus the role's own allows, minus its denies, all
 * intersected with the ceiling. An allow inherits the condition, approval and
 * limit of the declared grant it comes from: an included assignable role's
 * grant when there is one, otherwise every ceiling grant of that permission,
 * together with the denies of the roles those grants belong to.
 */
export function resolveCustomRole(
  policy: Policy,
  role: CustomRole,
): ResolvedCustomRole {
  const scope = customRoleScope(role);
  const ceiling = ceilingGrants(policy, scope);
  const ceilingSet = new Set(ceiling);
  const ceilingKeys = new Set(ceiling.map((grant) => grant.permission.key));
  const declared = declaredRoleNames(policy);
  const all = grantList(policy).filter((grant) => grant.hosted === undefined);
  const dropped: CustomRoleDrop[] = [];
  const seen = new Set<string>();
  const drop = (entry: CustomRoleDrop): void => {
    const id =
      'role' in entry
        ? `role:${entry.role}`
        : `${entry.reason}:${entry.permission}`;
    if (!seen.has(id)) {
      seen.add(id);
      dropped.push(entry);
    }
  };

  const included: Grant[] = [];
  const includedKeys = new Set<string>();
  const allowKeys = new Set<string>();
  const denyKeys = new Set<string>();

  for (const name of Array.isArray(role.includes) ? role.includes : []) {
    if (typeof name !== 'string' || !declared.has(name)) {
      drop({ role: String(name), reason: 'unknown-role' });
      continue;
    }
    for (const grant of all) {
      if (soleRole(grant) !== name) {
        continue;
      }
      const key = grant.permission.key;
      if (grant.effect === 'deny') {
        included.push(grant);
      } else if (ceilingSet.has(grant)) {
        included.push(grant);
        includedKeys.add(key);
      } else if (ceilingKeys.has(key)) {
        allowKeys.add(key);
      } else {
        drop({ permission: key, reason: 'outside-ceiling' });
      }
    }
  }

  const entries: readonly unknown[] = Array.isArray(role.grants)
    ? role.grants
    : [];
  for (const item of entries) {
    if (item === null || typeof item !== 'object') {
      drop({ permission: String(item), reason: 'unknown-permission' });
      continue;
    }
    const entry = item as {
      readonly permission?: unknown;
      readonly effect?: unknown;
    };
    const raw = entry.permission;
    const key = typeof raw === 'string' ? raw : String(raw);
    if (
      typeof raw !== 'string' ||
      findPermission(policy.permissions, raw)?.key !== raw
    ) {
      drop({ permission: key, reason: 'unknown-permission' });
      continue;
    }
    const effect = entry.effect ?? 'allow';
    const extra = Object.keys(entry).some((name) => !GRANT_KEYS.has(name));
    if (extra || (effect !== 'allow' && effect !== 'deny')) {
      drop({ permission: key, reason: 'condition-not-allowed' });
      // A malformed entry can only narrow: it still removes the permission.
      denyKeys.add(key);
      continue;
    }
    if (effect === 'deny') {
      denyKeys.add(key);
      continue;
    }
    if (!ceilingKeys.has(key)) {
      drop({ permission: key, reason: 'outside-ceiling' });
      continue;
    }
    allowKeys.add(key);
  }

  const out: Grant[] = [];
  const push = (grant: Grant): void => {
    if (!out.includes(grant)) {
      out.push(grant);
    }
  };
  for (const grant of included) {
    if (grant.effect === 'deny' || !denyKeys.has(grant.permission.key)) {
      push(grant);
    }
  }
  for (const key of allowKeys) {
    if (denyKeys.has(key) || includedKeys.has(key)) {
      continue;
    }
    const sources = new Set<string>();
    for (const grant of ceiling) {
      if (grant.permission.key === key) {
        push(grant);
        sources.add(soleRole(grant) ?? '');
      }
    }
    for (const grant of all) {
      if (
        grant.effect === 'deny' &&
        grant.permission.key === key &&
        sources.has(soleRole(grant) ?? '')
      ) {
        push(grant);
      }
    }
  }
  return freezeDeep({
    grants: out.map((grant) => retarget(grant, role, scope)),
    dropped,
  });
}

export function validateCustomRole(
  policy: Policy,
  role: CustomRole,
): CustomRoleValidation {
  const resolved = resolveCustomRole(policy, role);
  const permissions = [
    ...new Set(
      resolved.grants
        .filter((grant) => grant.effect === 'allow')
        .map((grant) => grant.permission.key),
    ),
  ].toSorted();
  return freezeDeep({
    ok: resolved.dropped.length === 0,
    permissions,
    dropped: resolved.dropped,
  });
}

function wellFormed(role: CustomRole): boolean {
  return (
    role !== null &&
    typeof role === 'object' &&
    typeof role.name === 'string' &&
    typeof role.tenant === 'string' &&
    (role.team === undefined || typeof role.team === 'string')
  );
}

/** Every custom role's resolved grants, once per instance. Malformed roles resolve to nothing. */
export function customGrantsFor(
  policy: Policy,
  roles: readonly CustomRole[],
): readonly CustomGrant[] {
  const declared = declaredRoleNames(policy);
  const out: CustomGrant[] = [];
  for (const role of roles) {
    if (!wellFormed(role) || declared.has(role.name)) {
      continue;
    }
    for (const grant of resolveCustomRole(policy, role).grants) {
      out.push({ grant, role });
    }
  }
  return out;
}

/** A declared role name always wins over a custom role of the same name. */
export function holdsCustomRole(
  membership: Membership,
  role: CustomRole,
): boolean {
  return (
    membership.tenant === role.tenant &&
    (role.team === undefined || membership.team === role.team) &&
    membership.roles.includes(role.name)
  );
}

export function isCustomRoleName(
  name: string,
  roles: readonly CustomRole[],
  tenant: string | undefined,
): boolean {
  return (
    tenant !== undefined &&
    roles.some(
      (item) =>
        wellFormed(item) && item.name === name && item.tenant === tenant,
    )
  );
}
