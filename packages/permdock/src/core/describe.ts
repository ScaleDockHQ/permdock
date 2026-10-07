import type { Approver } from "./approvers.ts";
import type {
  Decision,
  DeniedDecision,
  DenialReason,
  MatchedGrant,
} from "./decision.ts";
import type { Grantee } from "./grantee.ts";
import type { Permission } from "./permissions.ts";

import { flattenApprovers } from "./approvers.ts";
import { requiredPlans } from "./problem-details.ts";

export { requiredPlans };

export type DecisionDescription = {
  readonly kind:
    | "granted"
    | "denied"
    | "approval"
    | "tenant"
    | "delegation"
    | "server-only"
    | "upgrade";
  readonly title: string;
  readonly detail: string;
  readonly alternatives: readonly Permission[];
  /** On `upgrade`: the plans any of which would grant the permission. */
  readonly plans?: readonly string[];
};

const TENANT_REASONS = new Set([
  "tenant-mismatch",
  "no-membership",
  "expired-membership",
  "scope",
]);

const DELEGATION_REASONS = new Set(["not-delegated", "no-delegation"]);

function labelGrantee(grantee: Grantee): string {
  switch (grantee.kind) {
    case "role":
      return grantee.role;
    case "plan":
      return grantee.plan;
    case "actor":
      return grantee.actor;
    case "authenticated":
      return "an authenticated user";
    case "anyone":
      return "anyone";
    case "relation":
      return grantee.relation;
    case "inherit":
      return grantee.permission;
    case "assurance": {
      const parts: string[] = [];
      if (grantee.acr !== undefined && grantee.acr.length > 0) {
        parts.push(`acr ${grantee.acr.join("/")}`);
      }
      if (grantee.amr !== undefined && grantee.amr.length > 0) {
        parts.push(`amr ${grantee.amr.join("/")}`);
      }
      return parts.length > 0 ? parts.join(" ") : "step-up";
    }
    default: {
      const exhaustive: never = grantee;
      return exhaustive;
    }
  }
}

/**
 * Localised text for `describe`. Every entry is optional and falls back to the
 * English default; `kind` and `alternatives` never change.
 */
export type DescribeMessages = {
  readonly titles?: Partial<Record<DecisionDescription["kind"], string>>;
  /**
   * Text per denial reason; a denied detail joins the texts of its reasons
   * with `separator`. The function form also sees the decision; `undefined`
   * keeps the reason code, as a missing record entry does.
   */
  readonly reasons?:
    | Partial<Record<DenialReason, string>>
    | ((reason: DenialReason, decision: DeniedDecision) => string | undefined);
  /** Joins denial reason texts. Default `', '`. */
  readonly separator?: string;
  readonly granted?: (permission: string) => string;
  /** `approvers` is empty for `'human'` approval. */
  readonly approval?: (
    permission: string,
    approvers: readonly string[],
  ) => string;
  readonly upgrade?: (plans: readonly string[]) => string;
};

export type DescribeOptions = {
  readonly messages?: DescribeMessages;
};

const TITLES: Readonly<Record<DecisionDescription["kind"], string>> = {
  granted: "Granted",
  denied: "Denied",
  approval: "Approval required",
  tenant: "Wrong tenant",
  delegation: "Not delegated",
  "server-only": "Server only",
  upgrade: "Upgrade required",
};

function labelApprover(approver: Approver): string {
  if (approver.kind === "user") {
    return `user ${approver.id}`;
  }
  if (approver.kind === "permission") {
    return `a holder of ${approver.permission}`;
  }
  if (approver.kind === "any-of") {
    const groups = approver.of.map((entry) =>
      flattenApprovers(entry).map(labelApprover).join(" and "),
    );
    return `one of (${groups.join(", ")})`;
  }
  return labelGrantee(approver);
}

function approvers(approval: MatchedGrant["approval"]): readonly string[] {
  if (approval === undefined || approval === "human") {
    return [];
  }
  return [
    ...flattenApprovers(approval.by),
    ...(approval.stages ?? []).flatMap((stage) => flattenApprovers(stage.by)),
  ].map(labelApprover);
}

function approvalDetail(permission: string, labels: readonly string[]): string {
  if (labels.length === 0) {
    return `${permission} requires human approval.`;
  }
  return `${permission} requires approval from ${labels.join(" and ")}.`;
}

export function describe(
  decision: Decision,
  options?: DescribeOptions,
): DecisionDescription {
  const messages = options?.messages;
  const titleOf = (kind: DecisionDescription["kind"]): string =>
    messages?.titles?.[kind] ?? TITLES[kind];
  if (decision.outcome === "granted") {
    const { permission } = decision.matched;
    return {
      kind: "granted",
      title: titleOf("granted"),
      detail: messages?.granted?.(permission) ?? `${permission} granted.`,
      alternatives: [],
    };
  }
  if (decision.outcome === "approval-required") {
    const { permission } = decision.grant;
    const labels = approvers(decision.grant.approval);
    return {
      kind: "approval",
      title: titleOf("approval"),
      detail:
        messages?.approval?.(permission, labels) ??
        approvalDetail(permission, labels),
      alternatives: [],
    };
  }
  const plans = requiredPlans(decision);
  if (plans.length > 0) {
    return {
      kind: "upgrade",
      title: titleOf("upgrade"),
      detail:
        messages?.upgrade?.(plans) ?? `${plans.join(" or ")} plan required.`,
      alternatives: decision.alternatives,
      plans,
    };
  }
  const reasons = decision.denials.map((denial) => denial.reason);
  const kind = reasons.some((reason) => TENANT_REASONS.has(reason))
    ? "tenant"
    : reasons.some((reason) => DELEGATION_REASONS.has(reason))
      ? "delegation"
      : reasons.includes("opaque-condition") || reasons.includes("server-only")
        ? "server-only"
        : "denied";
  const texts = messages?.reasons;
  const detail = reasons
    .map(
      (reason) =>
        (typeof texts === "function"
          ? texts(reason, decision)
          : texts?.[reason]) ?? reason,
    )
    .join(messages?.separator ?? ", ");
  return {
    kind,
    title: titleOf(kind),
    detail,
    alternatives: decision.alternatives,
  };
}
