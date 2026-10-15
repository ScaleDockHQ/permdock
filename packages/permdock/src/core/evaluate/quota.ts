import type { Denial, GrantedDecision } from "../decision.ts";
import type { Grant } from "../policy-types.ts";
import type { Allow, EvaluationState } from "./state.ts";

import { compact } from "../compact.ts";
import { shouldConsumeQuota } from "../grant-conditions.ts";
import { applyQuota } from "../limits.ts";
import { requiresApproval } from "../policy.ts";
import { approvalOf } from "./approval.ts";

export type QuotaState = Pick<GrantedDecision, "quota" | "obligations">;

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
  const { subject, env } = state;
  const denials: Denial[] = [];
  for (const candidate of usable) {
    const approval = approvalOf(state, candidate);
    const quota = applyQuota({
      store: env.limits,
      cache: env.limitCache,
      grant: candidate.grant,
      permissionKey: state.permission.key,
      subjectId: subject.principal?.id ?? "",
      tenant: subject.principal?.tenant,
      now: state.now,
      consume:
        !requiresApproval(approval) &&
        shouldConsumeQuota(state.options.call, env.simulated),
    });
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
