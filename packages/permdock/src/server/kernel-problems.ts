import type { Decision } from "../core/decision.ts";
import type { ApprovalHint } from "../core/errors.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Subject } from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import { LOAD_FAILED } from "../core/decision.ts";
import { freezeDeep } from "../core/freeze.ts";
import { problemDetails } from "../core/problem-details.ts";
import { decisionResponse, problemFromDecision } from "./problem.ts";

export const NOT_DELEGATED: Extract<Decision, { readonly outcome: "denied" }> =
  freezeDeep({
    outcome: "denied",
    denials: [{ role: null, reason: "not-delegated" }],
    alternatives: [],
  });

/** The `403` for a loader that threw: the check fails closed, as on MCP. */
export function loadFailedProblem(permission: Permission | null): Response {
  const key = permission?.key ?? "the route";
  return decisionResponse(
    problemDetails(
      compact({
        decision: LOAD_FAILED,
        detail: `${key} failed closed: the row could not be loaded`,
        permission: permission?.key,
      }),
    ),
    LOAD_FAILED,
  );
}

/**
 * The `403` `insufficient_scope` for a token that holds none of a route's OAuth
 * scopes.
 */
export function scopeProblem(
  permission: Permission | null,
  subject: Subject,
  credentials: boolean,
  scope: string | undefined,
): Response {
  return permission === null
    ? decisionResponse(
        problemDetails(
          compact({
            decision: NOT_DELEGATED,
            detail: `the token holds none of the OAuth scopes this route needs, such as ${String(scope)}`,
            scope,
          }),
        ),
        NOT_DELEGATED,
        compact({ credentials, scope }),
      )
    : problemFromDecision(
        NOT_DELEGATED,
        permission,
        subject,
        compact({ credentials, scope }),
      );
}

export function problemFor(
  decision: Decision,
  init?: { readonly permission?: Permission; readonly instance?: string },
  approval?: ApprovalHint,
): Response {
  if (init?.permission !== undefined) {
    return problemFromDecision(
      decision,
      init.permission,
      undefined,
      compact({ instance: init.instance, approval }),
    );
  }
  if (decision.outcome === "granted") {
    return new Response(null, { status: 204 });
  }
  return decisionResponse(
    problemDetails(
      compact({ decision, detail: decision.outcome, instance: init?.instance }),
    ),
    decision,
  );
}
