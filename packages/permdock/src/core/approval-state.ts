import type { Subject } from "./subject.ts";

import { rootMembershipId } from "./scopes.ts";

/** The denial detail when an `ApprovalPolicySource` threw or returned an invalid entry. */
export const APPROVAL_POLICY_UNAVAILABLE = "approval-policy-unavailable";

/** The tenant a matched allow applies in: its membership's root scope, else the active tenant. */
export function decisionTenant(
  subject: Subject,
  membership: Parameters<typeof rootMembershipId>[0] | undefined,
): string | undefined {
  return (
    (membership === undefined ? undefined : rootMembershipId(membership)) ??
    subject.principal?.tenant
  );
}
