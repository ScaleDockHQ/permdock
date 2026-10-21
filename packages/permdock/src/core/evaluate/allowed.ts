import type { Decision, MatchedGrant } from "../decision.ts";
import type { Grant } from "../policy-types.ts";
import type { QuotaState } from "./quota.ts";
import type { Allow, EvaluationState } from "./state.ts";

import { compact } from "../compact.ts";
import { matchedOf } from "../grant-conditions.ts";
import { requiresApproval } from "../policy.ts";
import { rowIdOf } from "../row-pair.ts";
import { decisionToken, tokenPayload, versionOf } from "../token.ts";
import { complete } from "./complete.ts";

/**
 * The `granted` or `approval-required` decision for the chosen allow, with its
 * token.
 */
export function allowedDecision(
  state: EvaluationState,
  allow: Allow,
  approval: Grant["approval"],
  quotaState: QuotaState,
): Decision {
  const { policy, subject, permission, resource, env, current, next } = state;
  const resourceId =
    permission.kind === "collection" ? "*" : rowIdOf(current, resource?.id);
  const version =
    approval !== undefined &&
    approval !== "human" &&
    approval.staleOn === "resource-change" &&
    resource?.version !== undefined
      ? versionOf(current, resource.version)
      : undefined;
  const token = env.simulated
    ? "pd1.simulated"
    : env.outcomeOnly === true
      ? "pd1.outcome"
      : decisionToken({
          key: permission.key,
          resourceId,
          principal: subject.principal,
          actor: subject.actor,
          fingerprint: policy.fingerprint,
          version,
          payload: tokenPayload(
            resourceId,
            next ?? current,
            state.options.args,
          ),
        });
  const matched = compact<MatchedGrant>({
    ...matchedOf(allow.grant, permission.key, allow.breakGlass),
    approval,
  });
  const obligations = [
    ...(quotaState.obligations ?? []),
    ...(allow.obligations ?? []),
    ...(allow.grant.obligations ?? []),
  ];
  return complete(
    state,
    requiresApproval(approval)
      ? { outcome: "approval-required", grant: matched, reason: "human", token }
      : {
          outcome: "granted",
          subject,
          matched,
          token,
          ...quotaState,
          ...(obligations.length === 0 ? {} : { obligations }),
        },
    allow.membership,
  );
}
