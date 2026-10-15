import type { Grant } from "../policy-types.ts";
import type { Allow, EvaluationState } from "./state.ts";

import { decisionTenant } from "../approval-state.ts";

/** The allow's approval, tightened by the loaded `ApprovalPolicySource` entries. */
export function approvalOf(
  state: EvaluationState,
  candidate: Allow,
): Grant["approval"] {
  const approvalPolicies = state.env.approvalPolicies;
  return approvalPolicies === undefined || approvalPolicies === "failed"
    ? candidate.grant.approval
    : approvalPolicies.tighten(candidate.grant.approval, {
        permission: state.permission.key,
        tenant: decisionTenant(state.subject, candidate.membership),
        subject: state.subject,
        current: state.current,
        next: state.next,
        now: state.now,
        scopes: state.scopes,
        operation: state.options.operation?.meta,
      });
}
