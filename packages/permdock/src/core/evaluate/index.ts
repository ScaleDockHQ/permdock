import type { Decision } from "../decision.ts";
import type { EvalEnv } from "../events.ts";
import type { DecideOptions } from "../permdock.ts";
import type { Permission } from "../permission-types.ts";
import type { Policy } from "../policy-types.ts";
import type { Subject } from "../subject.ts";
import type { EvaluationCall, EvaluationState } from "./state.ts";

import { APPROVAL_POLICY_UNAVAILABLE } from "../approval-state.ts";
import { contactAllows } from "../contact.ts";
import { purposesOf } from "../elevated.ts";
import { isDelegatedPermission } from "../grant-conditions.ts";
import { getResource } from "../permission-registry.ts";
import { declaredRoleNames } from "../policy.ts";
import { rowValues } from "../row-pair.ts";
import { scopeList, subjectForPermission } from "../scopes.ts";
import { epochSeconds, INVALID_NOW } from "../time.ts";
import { allowedDecision } from "./allowed.ts";
import { heldRoles, lacksActor, validatedRows, walkRoleFor } from "./call.ts";
import {
  breakGlassFor,
  candidatesFor,
  evaluateCandidate,
  mergeBreakGlass,
} from "./candidates.ts";
import { deniedNow, deniedWithAlternatives } from "./complete.ts";
import { delegatedAllows, noAllowDecision } from "./post-allow.ts";
import { quotaAllow } from "./quota.ts";

/**
 * One decision, in stages: the call (clock, rows, delegated permission), the
 * subject (held roles, actor), the candidate grants (a matching deny ends
 * here), break-glass, freshness, delegation and contact, the approval and
 * quota of each usable allow, and the decision. Every exit goes through
 * `complete`, which freezes and emits.
 */
export function evaluate(
  policy: Policy,
  given: Subject,
  permission: Permission,
  data: unknown,
  options: DecideOptions,
  env: EvalEnv,
): Decision {
  const call: EvaluationCall = {
    policy,
    given,
    subject: subjectForPermission(given, permission.key),
    permission,
    options,
    env,
    now: epochSeconds(options.now),
    resource: getResource(policy.permissions, permission.resource),
    tracer:
      options.explain === true
        ? { evaluated: 0, allows: [], denies: [], skipped: [] }
        : undefined,
    evaluate,
  };

  // The call.
  if (!Number.isFinite(call.now)) {
    return deniedNow(
      { ...call, now: epochSeconds(), current: data },
      { role: null, reason: "validation", detail: INVALID_NOW },
    );
  }
  const rows = validatedRows(call, data, rowValues(permission, data));
  if (rows.invalid !== undefined) {
    return deniedNow(
      { ...call, current: rows.current },
      { role: null, reason: "validation", detail: rows.invalid },
    );
  }
  const settled = { ...call, current: rows.current };
  if (isDelegatedPermission(policy, permission)) {
    return deniedNow(settled, {
      role: null,
      reason: "pdp-unavailable",
      detail: "use permdock/pdp createPermDock",
    });
  }

  // The subject.
  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const roles = heldRoles(call, scopes, declared);
  if (lacksActor(call, scopes)) {
    return deniedNow(settled, { role: null, reason: "actor-required" });
  }
  const state: EvaluationState = {
    ...call,
    current: rows.current,
    next: rows.next,
    scopes,
    declared,
    roles,
    purposes: purposesOf(call.subject),
    walkRole: walkRoleFor(call),
    denials: roles.denials,
    allows: [],
  };

  // The candidate grants; a matching deny ends the call.
  const breakGlass = breakGlassFor(call, scopes);
  for (const candidate of candidatesFor(call)) {
    const decision = evaluateCandidate(state, candidate, breakGlass);
    if (decision !== undefined) {
      return decision;
    }
  }
  mergeBreakGlass(state, breakGlass);
  if (state.allows.length === 0) {
    return noAllowDecision(state);
  }

  // After an allow: freshness, delegation and contact.
  if (
    state.subject.stale === true &&
    (policy.fresh ?? []).includes(permission.key)
  ) {
    return deniedNow(state, { role: null, reason: "stale-credentials" });
  }
  const delegated = delegatedAllows(state);
  if (!Array.isArray(delegated)) {
    return delegated;
  }
  const usable = contactAllows(policy, state.subject, permission, delegated);
  if (usable.length === 0) {
    return deniedWithAlternatives(state, [
      { role: null, reason: "not-delegated" },
    ]);
  }

  // Approval and quota, then the decision.
  if (env.approvalPolicies === "failed") {
    return deniedNow(state, {
      role: null,
      reason: "approval",
      detail: APPROVAL_POLICY_UNAVAILABLE,
    });
  }
  const chosen = quotaAllow(state, usable);
  if ("denials" in chosen) {
    return deniedWithAlternatives(
      state,
      chosen.denials.length > 0 ? chosen.denials : state.denials,
    );
  }
  return allowedDecision(state, chosen.allow, chosen.approval, chosen.quota);
}
