import type { RelationGrantee } from "../core/grantee.ts";
import type { Approver, ApprovalMode, ApprovalStage } from "../core/policy.ts";
import type { Membership, Subject } from "../core/subject.ts";

import { parseDuration } from "../core/duration.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalApprovers = {
  /** Under `mode: 'any'` (the default). */
  readonly by?: Approver | readonly Approver[];
  readonly mode?: ApprovalMode;
  /** Under `mode: 'all'` or `'sequential'`. */
  readonly stages?: readonly ApprovalStage[];
  /** `false` lets the request's principal approve it; absent means `true`. */
  readonly distinct?: boolean;
  /** Set when the approval no longer applies once the row's `version` changes. */
  readonly staleOn?: "resource-change";
  /** Distinct approvers of `by` needed before `status` becomes `approved`; absent means 1. */
  readonly quorum?: number;
  /** Who else may approve once the request has waited `after` (a duration such as `'4h'`) since `createdAt`. */
  readonly escalation?: {
    readonly after: string;
    readonly to: Approver | readonly Approver[];
  };
};

/** One recorded approval: who gave it, when, and under `stages` the index of the stage it counts for. */
export type ApprovalSignature = {
  readonly by: string;
  readonly at: string;
  readonly stage?: number;
  readonly vouched?: string;
};

export type ApprovalSubjectSummary = {
  readonly principal: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly tenant?: string;
  } | null;
  readonly actor?: { readonly id: string; readonly kind: string };
  readonly session?: string;
  readonly delegation?: {
    readonly scopes?: readonly string[];
    readonly authorizationDetails?: readonly unknown[];
  };
};

export type ApprovalRequest = {
  readonly v: 1;
  readonly token: string;
  readonly permission: string;
  readonly scope: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly subject: ApprovalSubjectSummary;
  readonly membership?: Membership;
  readonly approvers?: ApprovalApprovers;
  readonly detail: string;
  readonly adapter?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  /** Approvals given so far, oldest first; the request is `approved` once there are `approvers.quorum` of them. */
  readonly approvals?: readonly ApprovalSignature[];
  readonly resolvedAt?: string;
  /** The approver whose verdict resolved the request (the last of `approvals` on a quorum), or `system:<by>` for a cancellation. */
  readonly resolvedBy?: string;
  readonly vouched?: string;
  readonly note?: string;
  readonly consumedAt?: string;
};

export type ApprovalVerdict = {
  readonly status: "approved" | "rejected";
  readonly by: Subject;
  readonly note?: string;
  /**
   * The relation approvers (by `approverRelationKey`) that `by` holds on the
   * request's resource, as `approverRelations` read them. Server-side input:
   * set it from a `RelationSource`, never from the request body. Absent means
   * none, so relation approvers match nobody.
   */
  readonly relations?: readonly string[];
  /**
   * The `holder(permission)` approvers (by permission key) that `by` holds
   * in the request's tenant, as `approverPermissions` read them from the
   * approver's own instance. Server-side input, never from the request body.
   * Absent means none, so permission approvers match nobody.
   */
  readonly permissions?: readonly string[];
  readonly vouched?: string;
};

export type ApprovalListFilter = {
  readonly status?: ApprovalStatus;
  readonly principalId?: string;
  readonly actorId?: string;
  readonly tenant?: string;
  readonly session?: string;
};

export type ApprovalListQuery = ApprovalListFilter & {
  /** Page size, 1 to 200; 50 when omitted. */
  readonly limit?: number;
  /** The `next` of the previous page; opaque to the caller. */
  readonly cursor?: string;
};

/**
 * One page, oldest `createdAt` first. `next` is absent on the last page; an
 * unreadable cursor yields an empty last page.
 */
export type ApprovalPage = {
  readonly items: readonly ApprovalRequest[];
  readonly next?: string;
};

export type ApprovalCancelMeta = {
  readonly by: string;
  readonly note?: string;
};

export type ApprovalStore = {
  /**
   * How long a request opened against this store stays open, in
   * milliseconds, when the caller sets no `ttl`; absent means
   * `DEFAULT_APPROVAL_TTL_MS`. A grant's `approval.ttl` still caps it.
   */
  readonly ttl?: number;
  create(request: ApprovalRequest): Promise<void> | void;
  get(token: string): Promise<ApprovalRequest | null> | ApprovalRequest | null;
  resolve(
    token: string,
    verdict: ApprovalVerdict,
  ): Promise<ApprovalRequest> | ApprovalRequest;
  list(query: ApprovalListQuery): Promise<ApprovalPage> | ApprovalPage;
  expire(now?: Date): Promise<number> | number;
  /**
   * Marks an approved, unexpired, unconsumed request consumed and returns it;
   * returns `null` otherwise. Must be atomic: two concurrent calls for one
   * token never both return the request.
   */
  consume(
    token: string,
    now?: Date,
  ): Promise<ApprovalRequest | null> | ApprovalRequest | null;
  cancel?(
    filter: ApprovalListFilter,
    meta: ApprovalCancelMeta,
  ): Promise<number> | number;
};

export type ApprovalResumeFailure =
  | "approval-not-found"
  | "approval-pending"
  | "approval-rejected"
  | "approval-expired"
  | "approval-consumed";

export type ApprovalInspectResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly detail: ApprovalResumeFailure };

export const APPROVAL_HEADER = "PermDock-Approval" as const;

export const DEFAULT_APPROVAL_TTL_MS: number = 60 * 60 * 1000;

/** The approvals a request needs in total: `approvers.quorum` (or 1), or the sum of its stages' quorums. */
export function approvalQuorum(request: ApprovalRequest): number {
  const stages = request.approvers?.stages;
  if (stages !== undefined) {
    return stages.reduce((sum, stage) => sum + (stage.quorum ?? 1), 0);
  }
  return request.approvers?.quorum ?? 1;
}

/**
 * The instant from which `approvers.escalation.to` may approve, in epoch
 * milliseconds, or `undefined` when the request has no escalation or its
 * `after` does not parse (then nobody escalates: fail-closed).
 */
export function escalationOpenAt(request: ApprovalRequest): number | undefined {
  const after = request.approvers?.escalation?.after;
  const seconds = parseDuration(after);
  if (seconds === undefined) {
    return undefined;
  }
  return Date.parse(request.createdAt) + seconds * 1000;
}

/** The instant from which a stage's own `escalation.to` may approve it, in epoch milliseconds; `undefined` when it has none or `after` does not parse. */
export function stageEscalationOpenAt(
  request: ApprovalRequest,
  stage: ApprovalStage,
): number | undefined {
  const seconds = parseDuration(stage.escalation?.after);
  if (seconds === undefined) {
    return undefined;
  }
  return Date.parse(request.createdAt) + seconds * 1000;
}

/** The key a verdict's `relations` lists a relation approver under. */
export function approverRelationKey(item: RelationGrantee): string {
  return JSON.stringify([
    item.resource,
    item.relation,
    item.through ?? null,
    item.depth ?? null,
  ]);
}
