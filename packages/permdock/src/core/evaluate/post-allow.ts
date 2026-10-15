import type { Decision, DenialReason } from "../decision.ts";
import type { Allow, EvaluationState } from "./state.ts";

import {
  coveredByDelegation,
  coversRequirements,
  delegatedPermissions,
  requiresStandIn,
} from "../delegation.ts";
import { resourceIdOf } from "../resource-ref.ts";
import { deniedWithAlternatives } from "./complete.ts";

export function noAllowDecision(state: EvaluationState): Decision {
  const { denials, subject, roles } = state;
  const reason: DenialReason =
    denials[0]?.reason ??
    (subject.principal === null
      ? "anonymous"
      : roles.global.unknown.length > 0 && roles.global.roles.length === 0
        ? "unknown-role"
        : "no-grant");
  return deniedWithAlternatives(
    state,
    denials.length > 0 ? denials : [{ role: null, reason }],
  );
}

/**
 * The allows a delegation leaves usable. A policy delegation is a ceiling for
 * the actor: outside it, nothing is delegated; inside it, a token delegation
 * on the call must still cover.
 */
export function delegatedAllows(state: EvaluationState): Allow[] | Decision {
  const { policy, subject, permission, current } = state;
  const ceiling = delegatedPermissions(
    policy.delegations,
    subject,
    state.roles.matching,
    state.now,
  );
  if (ceiling !== undefined && !ceiling.has(permission.key)) {
    return deniedWithAlternatives(state, [
      { role: null, reason: "not-delegated" },
    ]);
  }
  const unscoped = subject.actor !== undefined && ceiling === undefined;
  let delegationMiss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
    unscoped,
  );
  const requirementsCovered = state.allows.filter((candidate) =>
    coversRequirements(
      policy.permissions,
      candidate.grant.requires,
      subject.delegation,
      resourceIdOf(current),
      unscoped,
    ),
  );
  const usable =
    delegationMiss === undefined
      ? requirementsCovered
      : requirementsCovered.filter((candidate) =>
          requiresStandIn(candidate.grant),
        );
  if (delegationMiss === "not-delegated" && usable.length > 0) {
    delegationMiss = undefined;
  }
  if (delegationMiss === undefined && usable.length === 0) {
    delegationMiss = "not-delegated";
  }
  if (delegationMiss !== undefined) {
    return deniedWithAlternatives(state, [
      { role: null, reason: delegationMiss },
    ]);
  }
  return usable;
}
