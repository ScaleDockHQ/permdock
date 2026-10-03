import type { Grantee } from "../core/grantee.ts";
import type { Membership, Subject } from "../core/subject.ts";

import { parseDuration } from "../core/duration.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalApprovers = {
  readonly by: Grantee | readonly Grantee[];
  /** `false` lets the request's principal approve it; absent means `true`. */
  readonly distinct?: boolean;
  /** Set when the approval no longer applies once the row's `version` changes. */
  readonly staleOn?: "resource-change";
  /** Distinct approvers needed before `status` becomes `approved`; absent means 1. */
  readonly quorum?: number;
  /** Who else may approve once the request has waited `after` (a duration such as `'4h'`) since `createdAt`. */
  readonly escalation?: {
    readonly after: string;
    readonly to: Grantee | readonly Grantee[];
  };
};

/** One recorded approval: who gave it and when. */
export type ApprovalSignature = {
  readonly by: string;
  readonly at: string;
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
  readonly note?: string;
  readonly consumedAt?: string;
};

export type ApprovalVerdict = {
  readonly status: "approved" | "rejected";
  readonly by: Subject;
  readonly note?: string;
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

/** The approvers a request needs: `approvers.quorum`, or 1. */
export function approvalQuorum(request: ApprovalRequest): number {
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
