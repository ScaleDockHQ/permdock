import type { Denial, GrantedDecision } from "../decision.ts";
import type { QuotaVerdict } from "../limits.ts";
import type { Grant } from "../policy-types.ts";
import type { Allow, EvaluationState } from "./state.ts";

import { compact } from "../compact.ts";
import { shouldConsumeQuota } from "../grant-conditions.ts";
import { requiresApproval } from "../policy.ts";
import { approvalOf } from "./approval.ts";

export type QuotaState = Pick<GrantedDecision, "quota" | "obligations">;

/**
 * The quota verdict for one allow: free without a `limit`, unavailable without
 * the `limits()` feature.
 */
function quotaOf(
  state: EvaluationState,
  grant: Grant,
  consume: boolean,
): QuotaVerdict {
  const { env, subject } = state;
  if (grant.limit === undefined) {
    return { ok: true };
  }
  if (env.limits === undefined) {
    return { ok: false, reason: "limit-unavailable" };
  }
  return env.limits.quota({
    cache: env.limitCache,
    limit: grant.limit,
    permissionKey: state.permission.key,
    subjectId: subject.principal?.id ?? "",
    tenant: subject.principal?.tenant,
    now: state.now,
    consume,
  });
}

/** The first usable allow whose quota admits the call, or the quota denials. */
export function quotaAllow(
  state: EvaluationState,
  usable: readonly Allow[],
):
  | {
      readonly allow: Allow;
      readonly approval: Grant["approval"];
      readonly quota: QuotaState;
    }
  | { readonly denials: readonly Denial[] } {
  const denials: Denial[] = [];
  for (const candidate of usable) {
    const approval = approvalOf(state, candidate);
    const quota = quotaOf(
      state,
      candidate.grant,
      !requiresApproval(approval) &&
        shouldConsumeQuota(state.options.call, state.env.simulated),
    );
    if (quota.ok) {
      return {
        allow: candidate,
        approval,
        quota: compact({ quota: quota.quota, obligations: quota.obligations }),
      };
    }
    denials.push(
      quota.reason === "limit"
        ? { role: candidate.grant.role, reason: "limit", detail: quota.detail }
        : { role: candidate.grant.role, reason: quota.reason },
    );
  }
  return { denials };
}
