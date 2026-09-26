import type { Grantee } from '../core/grantee.ts';
import type { Membership, Subject } from '../core/subject.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type ApprovalApprovers = {
  readonly by: Grantee | readonly Grantee[];
  readonly distinct?: boolean;
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
  readonly v: 1 | 2;
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
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly note?: string;
  readonly consumedAt?: string;
};

export type ApprovalVerdict = {
  readonly status: 'approved' | 'rejected';
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
  list(
    filter: ApprovalListFilter,
  ): Promise<ApprovalRequest[]> | ApprovalRequest[];
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
  | 'approval-not-found'
  | 'approval-pending'
  | 'approval-rejected'
  | 'approval-expired'
  | 'approval-consumed';

export type ApprovalInspectResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly detail: ApprovalResumeFailure };

export const APPROVAL_HEADER = 'PermDock-Approval' as const;

export const DEFAULT_APPROVAL_TTL_MS: number = 60 * 60 * 1000;
