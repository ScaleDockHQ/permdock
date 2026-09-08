import { g as Subject, m as Membership } from "./ast-BtUySn6K.js";
//#region src/approvals/types.d.ts
type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
type ApprovalSubjectSummary = {
  readonly principal: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly tenant?: string;
  } | null;
  readonly actor?: {
    readonly id: string;
    readonly kind: string;
  };
  readonly delegation?: {
    readonly scopes?: readonly string[];
    readonly authorizationDetails?: readonly unknown[];
  };
};
type ApprovalRequest = {
  readonly v: 1;
  readonly token: string;
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: ApprovalSubjectSummary;
  readonly membership?: Membership;
  readonly detail: string;
  readonly adapter?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly note?: string;
};
type ApprovalVerdict = {
  readonly status: "approved" | "rejected";
  readonly by: Subject;
  readonly note?: string;
};
type ApprovalListFilter = {
  readonly status?: ApprovalStatus;
  readonly principalId?: string;
  readonly actorId?: string;
  readonly tenant?: string;
};
type ApprovalStore = {
  create(request: ApprovalRequest): Promise<void> | void;
  get(token: string): Promise<ApprovalRequest | null> | ApprovalRequest | null;
  resolve(token: string, verdict: ApprovalVerdict): Promise<ApprovalRequest> | ApprovalRequest;
  list(filter: ApprovalListFilter): Promise<ApprovalRequest[]> | ApprovalRequest[];
  expire(now?: Date): Promise<number> | number;
};
type ApprovalResumeFailure = "approval-not-found" | "approval-pending" | "approval-rejected" | "approval-expired";
type ApprovalInspectResult = {
  readonly ok: true;
  readonly request: ApprovalRequest;
} | {
  readonly ok: false;
  readonly detail: ApprovalResumeFailure;
};
declare const APPROVAL_HEADER: "PermDock-Approval";
declare const DEFAULT_APPROVAL_TTL_MS: number;
//#endregion
export { ApprovalResumeFailure as a, ApprovalSubjectSummary as c, ApprovalRequest as i, ApprovalVerdict as l, ApprovalInspectResult as n, ApprovalStatus as o, ApprovalListFilter as r, ApprovalStore as s, APPROVAL_HEADER as t, DEFAULT_APPROVAL_TTL_MS as u };