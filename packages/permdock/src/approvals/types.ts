import type { AppData } from "../core/app-data.ts";
import type { RelationGrantee } from "../core/grantee.ts";
import type { AdapterId } from "../core/open-union.ts";
import type {
  ApprovalCombine,
  ApprovalMode,
  ApprovalStage,
} from "../core/policy-types.ts";
import type { Approver } from "../core/policy.ts";
import type { Membership, Subject } from "../core/subject.ts";
import type { Instant } from "../core/time.ts";
import type { WireDelegation } from "../core/wire-delegation.ts";

import { durationOf } from "../core/time.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalApprovers = {
  /** Under `combine: 'any'` (the default). */
  readonly by?: Approver | readonly Approver[];
  readonly combine?: ApprovalCombine;
  /** Under `combine: 'all'` or `'sequential'`. */
  readonly stages?: readonly ApprovalStage[];
  /**
   * `'confirm'` lets the request's principal approve it; absent means
   * `'authorize'`.
   */
  readonly mode?: ApprovalMode;
  /** Set when the approval no longer applies once the row's `version` changes. */
  readonly staleOn?: "resource-change";
  /**
   * Distinct approvers of `by` needed before `status` becomes `approved`;
   * absent means 1.
   */
  readonly quorum?: number;
  /**
   * Who else may approve once the request has waited `after` seconds since
   * `createdAt`.
   */
  readonly escalation?: {
    readonly after: number;
    readonly to: Approver | readonly Approver[];
  };
};

/**
 * One recorded approval: who gave it, when, and under `stages` the index of the
 * stage it counts for.
 */
export type ApprovalSignature = {
  readonly by: string;
  readonly at: string;
  readonly stage?: number;
  readonly vouched?: string;
  /**
   * The principal `by` approved for, when `by` acted under an
   * `ApprovalDelegation`.
   */
  readonly onBehalfOf?: string;
  /** The `ApprovalDelegation` id `onBehalfOf` was read from. */
  readonly delegation?: string;
};

/**
 * One out-of-office delegation: `delegate` may approve what `delegator` could
 * approve, from `from` until `until`. Both instants are required, so a
 * delegation cannot be open-ended. `permissions` and `resources` narrow it;
 * absent, it covers every request. `tenant` holds it to one tenant.
 */
export type ApprovalDelegation = {
  readonly id: string;
  readonly delegator: string;
  readonly delegate: string;
  readonly tenant?: string;
  readonly permissions?: readonly string[];
  readonly resources?: readonly string[];
  /** RFC 3339. Inclusive. */
  readonly from: string;
  /** RFC 3339. Exclusive. */
  readonly until: string;
};

/**
 * Active approval delegations for one delegate, a subject input the handler
 * reads when the caller is not an approver on their own. A throw matches
 * nobody. One hop: the handler never reads the delegator's own delegations.
 */
export type ApprovalDelegationSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  delegationsFor: (query: {
    readonly delegate: string;
    readonly tenant?: string;
    /** RFC 3339. The source returns delegations active at this instant. */
    readonly at: string;
  }) => readonly ApprovalDelegation[] | Promise<readonly ApprovalDelegation[]>;
};

export type ApprovalSubjectSummary = {
  readonly principal: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly tenant?: string;
  } | null;
  readonly actor?: { readonly id: string; readonly kind: string };
  readonly session?: string;
  /** OAuth `scope` (space-separated) and RFC 9396 `authorization_details`. */
  readonly delegation?: WireDelegation;
};

export type ApprovalRequest = {
  readonly v: 1;
  /** The request id: the signature's `jti`. */
  readonly id: string;
  readonly token: string;
  readonly permission: string;
  readonly scope: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly subject: ApprovalSubjectSummary;
  readonly membership?: Membership;
  readonly approvers?: ApprovalApprovers;
  readonly detail: string;
  readonly adapter?: AdapterId;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  /**
   * Approvals given so far, oldest first; the request is `approved` once there
   * are `approvers.quorum` of them.
   */
  readonly approvals?: readonly ApprovalSignature[];
  readonly resolvedAt?: string;
  /**
   * The approver whose verdict resolved the request (the last of `approvals` on
   * a quorum), or `system:<by>` for a cancellation.
   */
  readonly resolvedBy?: string;
  readonly vouched?: string;
  readonly note?: string;
  readonly consumedAt?: string;
  /**
   * The application's own data, set when the request opens; plain JSON, never
   * read by a decision.
   */
  readonly x?: AppData;
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
   * The `holder(permission)` approvers (by permission key) that `by` holds in
   * the request's tenant, as `approverPermissions` read them from the
   * approver's own instance. Server-side input, never from the request body.
   * Absent means none, so permission approvers match nobody.
   */
  readonly permissions?: readonly string[];
  readonly vouched?: string;
  /**
   * Set when `by` is not an approver and acts for this principal under an
   * `ApprovalDelegation`. Server-side input: the handler resolves the
   * delegator, and `applyApprovalVerdict` checks them again. `relations` and
   * `permissions` are that principal's facts, never the delegate's.
   */
  readonly onBehalfOf?: {
    readonly subject: Subject;
    readonly delegation: string;
    readonly relations?: readonly string[];
    readonly permissions?: readonly string[];
  };
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
  /** Names the implementation in errors and events. */
  readonly name?: string;
  /**
   * Seconds a request opened against this store stays open when the caller sets
   * no `ttl`; absent means `DEFAULT_APPROVAL_TTL`. A grant's `approval.ttl`
   * still caps it.
   */
  readonly ttl?: number;
  create: (request: ApprovalRequest) => Promise<void> | void;
  get: (
    token: string,
  ) => Promise<ApprovalRequest | null> | ApprovalRequest | null;
  /**
   * The request with this `id`, for `approvalsHandler`, which routes by id.
   * Without it the handler pages through `list` to find the id.
   */
  getById?: (
    id: string,
  ) => Promise<ApprovalRequest | null> | ApprovalRequest | null;
  resolve: (
    token: string,
    verdict: ApprovalVerdict,
  ) => Promise<ApprovalRequest> | ApprovalRequest;
  list: (query: ApprovalListQuery) => Promise<ApprovalPage> | ApprovalPage;
  expire: (now?: Instant) => Promise<number> | number;
  /**
   * Marks an approved, unexpired, unconsumed request consumed and returns it;
   * returns `null` otherwise. Must be atomic: two concurrent calls for one
   * token never both return the request.
   */
  consume: (
    token: string,
    now?: Instant,
  ) => Promise<ApprovalRequest | null> | ApprovalRequest | null;
  cancel?: (
    filter: ApprovalListFilter,
    meta: ApprovalCancelMeta,
  ) => Promise<number> | number;
};

export type ApprovalResumeFailureCause =
  | "approval-not-found"
  | "approval-pending"
  | "approval-rejected"
  | "approval-expired"
  | "approval-consumed";

export type ApprovalInspectResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly cause: ApprovalResumeFailureCause };

export const APPROVAL_HEADER = "PermDock-Approval" as const;

/**
 * Seconds a request stays open when neither the store nor the call sets a
 * `ttl`.
 */
export const DEFAULT_APPROVAL_TTL: number = 60 * 60;

/**
 * The approvals a request needs in total: `approvers.quorum` (or 1), or the sum
 * of its stages' quorums.
 */
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
  const seconds = durationOf(request.approvers?.escalation?.after);
  if (seconds === undefined) {
    return undefined;
  }
  return Date.parse(request.createdAt) + seconds * 1000;
}

/**
 * The instant from which a stage's own `escalation.to` may approve it, in epoch
 * milliseconds; `undefined` when it has none or `after` does not parse.
 */
export function stageEscalationOpenAt(
  request: ApprovalRequest,
  stage: ApprovalStage,
): number | undefined {
  const seconds = durationOf(stage.escalation?.after);
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
