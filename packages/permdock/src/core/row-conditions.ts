import type { Grant, Policy } from "./policy.ts";

const ROW_GRANTEES = new Set([
  "relation",
  "plan",
  "actor",
  "assurance",
  "inherit",
]);

/**
 * Whether a grant depends on more than the role and the scope: a row or body
 * condition, a closure, a field list, a purpose, a break-glass override, a
 * validity window, a `requires`, or a relation, plan, actor or assurance grantee. The SQL helpers
 * (`permdock_has`, `permitted_<scope>_ids`) check only role and scope, so a
 * policy that calls them for such a permission would widen access.
 */
function grantHasRowConditions(grant: Grant): boolean {
  const grantees = Array.isArray(grant.to) ? grant.to : [grant.to];
  return (
    grant.where !== undefined ||
    grant.check !== undefined ||
    grant.closure !== undefined ||
    !grant.portable ||
    grant.fields !== undefined ||
    grant.purpose !== undefined ||
    grant.breakGlass !== undefined ||
    grant.validity !== undefined ||
    grant.requires !== undefined ||
    grantees.some((grantee: { readonly kind: string }) =>
      ROW_GRANTEES.has(grantee.kind),
    )
  );
}

/** Per permission key, whether any code grant for it has row conditions. */
export function policyRowConditionKeys(policy: Policy): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const grant of [
    ...policy.grants,
    ...policy.roles.flatMap((binding) => binding.grants),
  ]) {
    if (grant.hosted === undefined && grantHasRowConditions(grant)) {
      keys.add(grant.permission.key);
    }
  }
  return keys;
}
