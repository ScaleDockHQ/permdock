import type {
  Grant,
  PolicyAppDataSchemas,
  PolicyDelegation,
  PolicyLevels,
} from "./policy-types.ts";

import { canonicalJson } from "./canonical-json.ts";

export function canonicalPolicy(
  grants: readonly Grant[],
  delegations: readonly PolicyDelegation[],
  levels: PolicyLevels | undefined,
  orderedLevels: readonly string[] = [],
): string {
  const payload = canonicalGrants(grants);
  const withDelegations =
    delegations.length === 0
      ? payload
      : `${payload}\n${JSON.stringify(delegations)}`;
  const withLevels =
    levels === undefined
      ? withDelegations
      : `${withDelegations}\nlevels:${canonicalJson(levels)}`;
  return orderedLevels.length === 0
    ? withLevels
    : `${withLevels}\norderedLevels:${JSON.stringify(orderedLevels)}`;
}

function canonicalGrants(grants: readonly Grant[]): string {
  const payload = grants.map((grant) => ({
    permission: grant.permission.key,
    effect: grant.effect,
    to: grant.to,
    role: grant.role,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    portable: grant.portable,
    fields: grant.fields,
    scope: grant.scope,
    name: grant.name,
    purpose: grant.purpose,
    breakGlass: grant.breakGlass,
    viaOnly: grant.viaOnly,
    validity: grant.validity,
    requires: grant.requires,
  }));
  return JSON.stringify(payload);
}

export const POLICY_X: unique symbol = Symbol.for("permdock.policy-x");

/** The app data schemas of `policy`. */
export function policyX(policy: object): PolicyAppDataSchemas | undefined {
  if (!Object.hasOwn(policy, POLICY_X)) {
    return undefined;
  }
  // SAFETY: definePolicy is the only writer of POLICY_X and stores the x option.
  return Reflect.get(policy, POLICY_X) as PolicyAppDataSchemas;
}
