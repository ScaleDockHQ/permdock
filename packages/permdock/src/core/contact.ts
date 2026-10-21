import type { Permission } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { Membership, Principal, Subject } from "./subject.ts";

import { annotationsFor } from "./permission-leaf.ts";

export function isContact(principal: Principal | null | undefined): boolean {
  return principal?.kind === "contact";
}

/**
 * A contact's memberships: only the `{ on }` ones count, each as `via:
 * 'contact'` and without seats, so a role whose `for` excludes `contact` never
 * applies and no `plan()` grantee matches.
 */
export function contactMemberships(
  memberships: readonly Membership[],
): readonly Membership[] {
  const kept: Membership[] = [];
  for (const membership of memberships) {
    if (membership.on === undefined) {
      continue;
    }
    const { entitlements: _seats, ...rest } = membership;
    kept.push(Object.freeze({ ...rest, via: "contact" }));
  }
  return kept;
}

function optsIn(policy: Policy, grant: Grant): boolean {
  if (grant.role === null) {
    return false;
  }
  const binding = policy.roles.find(({ name }) => name === grant.role);
  return binding?.for?.includes("contact") === true;
}

/**
 * Whether `subject` may use the allow `grant`: false only for a contact and a
 * write its role does not open to contacts.
 */
export function contactMayUse(
  policy: Policy,
  subject: Subject,
  grant: Grant,
): boolean {
  return (
    grant.effect !== "allow" ||
    !isContact(subject.principal) ||
    annotationsFor(grant.permission).readOnlyHint ||
    optsIn(policy, grant)
  );
}

/**
 * The allows a contact may use for `permission`: all of them for a read-only
 * permission, otherwise only those from a role whose `for` lists `contact`.
 * Every other subject keeps every allow.
 */
export function contactAllows<TAllow extends { readonly grant: Grant }>(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  allows: readonly TAllow[],
): readonly TAllow[] {
  if (
    !isContact(subject.principal) ||
    annotationsFor(permission).readOnlyHint
  ) {
    return allows;
  }
  return allows.filter(({ grant }) => optsIn(policy, grant));
}
