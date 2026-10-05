import type { Decision } from "./decision.ts";
import type { ProblemDetails } from "./errors.ts";
import type { Grantee } from "./grantee.ts";

import { compact } from "./compact.ts";
import { wireDenials } from "./wire-denial.ts";

export const PROBLEM_BASE = "https://permdock.com/problems";

export type Disclosure = "hide" | "reveal";

/** What every non-granted decision's Problem Details carry besides the decision. */
export type DecisionProblem = {
  readonly decision: Exclude<Decision, { readonly outcome: "granted" }>;
  readonly detail: string;
  readonly permission?: string;
  readonly scope?: string;
  readonly resource?: { readonly type: string; readonly id?: string };
  readonly instance?: string;
  /** `'hide'` on a loaded row: a denial that reveals nothing answers as `404` `/not-found`. */
  readonly disclosure?: Disclosure;
};

/** Reasons that only arise once a matching grant was found, so they reveal nothing hidden. */
const HOLDS_GRANT = new Set<string>([
  "insufficient-user-authentication",
  "limit",
  "limit-unavailable",
]);

function granteesOf(
  to: Grantee | readonly Grantee[] | undefined,
): readonly Grantee[] {
  if (to === undefined) {
    return [];
  }
  // SAFETY: to is Grantee | readonly Grantee[]; Array.isArray does not narrow readonly arrays.
  return Array.isArray(to) ? (to as readonly Grantee[]) : [to as Grantee];
}

/** The plans a `not-entitled` denial asks for; empty unless every denial is `not-entitled`. */
export function requiredPlans(decision: Decision): readonly string[] {
  if (
    decision.outcome !== "denied" ||
    decision.denials.length === 0 ||
    decision.denials.some((denial) => denial.reason !== "not-entitled")
  ) {
    return [];
  }
  const plans = new Set<string>();
  for (const denial of decision.denials) {
    for (const item of granteesOf(denial.to)) {
      if (item.kind === "plan") {
        plans.add(item.plan);
      }
    }
  }
  return [...plans];
}

/** The `acr` values and the tightest `maxAge` the failing assurance grants ask for. */
export function stepUpOf(decision: Decision): {
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
} {
  if (decision.outcome !== "denied") {
    return {};
  }
  const acr = new Set<string>();
  let maxAge: number | undefined;
  for (const denial of decision.denials) {
    if (denial.reason !== "insufficient-user-authentication") {
      continue;
    }
    for (const grantee of granteesOf(denial.to)) {
      if (grantee.kind !== "assurance") {
        continue;
      }
      for (const value of grantee.acr ?? []) {
        acr.add(value);
      }
      if (grantee.maxAge !== undefined) {
        maxAge =
          maxAge === undefined
            ? grantee.maxAge
            : Math.min(maxAge, grantee.maxAge);
      }
    }
  }
  return compact({
    acrValues: acr.size === 0 ? undefined : [...acr],
    maxAge,
  });
}

/** The `404` a missing row and a hidden one share, so the two read the same. */
export function notFoundDetails(instance?: string): ProblemDetails {
  return compact<ProblemDetails>({
    type: `${PROBLEM_BASE}/not-found`,
    title: "Not found",
    status: 404,
    detail: "No such resource",
    instance,
  });
}

/**
 * The RFC 9457 body for a decision that is not `granted`. One status matrix
 * serves `protect`, a thrown `assert` and `problemFromError`: `401` for an
 * anonymous subject or a step-up, `404` for a hidden row, `429` for an
 * exhausted limit, `503` for an unavailable limit store, `403` otherwise.
 */
export function problemDetails(input: DecisionProblem): ProblemDetails {
  const { decision } = input;
  const base = compact({
    instance: input.instance,
    permission: input.permission,
    scope: input.scope,
    resource: input.resource,
  });
  if (decision.outcome === "approval-required") {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/approval-required`,
      title: "Approval required",
      status: 403,
      detail: input.detail,
      ...base,
      reason: decision.reason,
      token: decision.token,
    });
  }
  const reasons = new Set(decision.denials.map((denial) => denial.reason));
  if (
    input.disclosure === "hide" &&
    ![...reasons].every((reason) => HOLDS_GRANT.has(reason))
  ) {
    return notFoundDetails(input.instance);
  }
  if (reasons.has("anonymous")) {
    return compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/unauthenticated`,
      title: "Authentication required",
      status: 401,
      detail: "Authenticate and repeat the request",
      instance: input.instance,
      permission: input.permission,
    });
  }
  const denied = compact<ProblemDetails>({
    type: `${PROBLEM_BASE}/denied`,
    title: "Permission denied",
    status: 403,
    detail: input.detail,
    ...base,
    denials: wireDenials(decision.denials),
    alternatives: decision.alternatives.map((leaf) => leaf.key),
  });
  if (reasons.has("insufficient-user-authentication")) {
    return {
      ...denied,
      status: 401,
      type: `${PROBLEM_BASE}/step-up-required`,
      ...stepUpOf(decision),
    };
  }
  const plans = requiredPlans(decision);
  if (plans.length > 0) {
    return {
      ...denied,
      type: `${PROBLEM_BASE}/not-entitled`,
      title: "Plan upgrade required",
      plans,
    };
  }
  if (reasons.size > 0 && [...reasons].every((reason) => reason === "limit")) {
    return {
      ...denied,
      status: 429,
      type: `${PROBLEM_BASE}/rate-limited`,
      title: "Rate limit exceeded",
    };
  }
  if (
    reasons.has("limit-unavailable") &&
    [...reasons].every(
      (reason) => reason === "limit" || reason === "limit-unavailable",
    )
  ) {
    return {
      ...denied,
      status: 503,
      type: `${PROBLEM_BASE}/limit-unavailable`,
      title: "Rate limit unavailable",
    };
  }
  return denied;
}
