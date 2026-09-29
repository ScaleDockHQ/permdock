import type { AuthEvent } from './interfaces.ts';
import type { Permission } from './permissions.ts';
import type { Policy } from './policy.ts';
import type { Principal, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { declaredRoleNames } from './evaluate.ts';
import { flattenGrantee } from './grantee.ts';
import { collectSnapshotGrants } from './instance.ts';
import { grantList } from './policy.ts';
import { resolveSubject } from './resolve-subject.ts';
import { isThenable } from './thenable.ts';
import { listPlans } from './vocabulary.ts';

function policyPlans(policy: Policy): readonly string[] {
  const names = new Set(listPlans(policy.vocabulary?.plans).map((p) => p.key));
  for (const grant of grantList(policy)) {
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind === 'plan') {
        names.add(item.plan);
      }
    }
  }
  return [...names];
}

function heldRoleNames(principal: Principal): readonly string[] {
  return [
    ...(principal.roles ?? []),
    ...(principal.memberships ?? []).flatMap((item) => item.roles),
  ];
}

/**
 * An optimistic routing hint for a proxy or middleware, never a decision.
 * `false` only when the subject's declared roles provably lack `permission`;
 * `true` whenever custom roles, plans, memberships the claims do not carry or
 * row conditions could still grant it. Synchronous, no network, never throws.
 * Pages, Server Actions and RLS remain the enforcement points.
 */
export function mayAccess(
  policy: Policy,
  user: unknown,
  permission: Permission,
  options: { readonly tenant?: string } = {},
): boolean {
  try {
    const auth: AuthEvent[] = [];
    const resolved = resolveSubject(
      policy,
      user,
      compact({ tenant: options.tenant }),
      auth,
    );
    if (isThenable(resolved)) {
      return true;
    }
    const principal = resolved.principal;
    const relevant = grantList(policy).filter(
      (grant) => grant.permission.key === permission.key,
    );
    if (principal !== null) {
      const declared = declaredRoleNames(policy);
      if (heldRoleNames(principal).some((name) => !declared.has(name))) {
        return true;
      }
      if (
        (principal.memberships ?? []).length === 0 &&
        relevant.some((grant) => grant.scope !== 'global')
      ) {
        return true;
      }
    }
    const tenant = options.tenant;
    const subject: Subject =
      principal === null
        ? resolved
        : {
            ...resolved,
            principal: {
              ...principal,
              plans: policyPlans(policy),
              memberships: (principal.memberships ?? []).filter(
                (item) =>
                  tenant === undefined ||
                  item.tenant === undefined ||
                  item.tenant === tenant,
              ),
            },
          };
    const matched = collectSnapshotGrants(policy, subject, []).filter(
      (item) => item.grant.permission.key === permission.key,
    );
    const unconditionalDeny = matched.some(
      (item) =>
        item.grant.effect === 'deny' &&
        item.grant.where === undefined &&
        item.grant.check === undefined &&
        item.grant.portable,
    );
    if (unconditionalDeny) {
      return false;
    }
    return matched.some((item) => item.grant.effect === 'allow');
  } catch {
    return true;
  }
}
