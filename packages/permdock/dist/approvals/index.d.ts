import { E as Membership, O as Subject, p as TokenSigner } from "../interfaces-D45oN5-b.js";
import { T as Permission, n as Decision } from "../decision-JylG_mtz.js";
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
export declare const APPROVAL_HEADER: "PermDock-Approval";
export declare const DEFAULT_APPROVAL_TTL_MS: number;
//#endregion
//#region src/approvals/handler.d.ts
type ApprovalsHandlerOptions = {
  readonly subject: (request: Request) => Subject | Promise<Subject> | null | undefined;
  readonly requireDistinctApprover?: boolean;
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
};
export declare function approvalsHandler(store: ApprovalStore, options: ApprovalsHandlerOptions): (request: Request) => Promise<Response>;
//#endregion
//#region src/approvals/helpers.d.ts
export declare function summariseSubject(subject: Subject): ApprovalRequest["subject"];
export declare function requestApproval(store: ApprovalStore, decision: Extract<Decision, {
  readonly outcome: "approval-required";
}>, meta: {
  readonly permission: Permission | {
    readonly key: string;
    readonly scope: string;
    readonly resource: string;
  };
  readonly resource?: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: Subject;
  readonly membership?: Membership;
  readonly adapter?: string;
  readonly ttl?: number;
  readonly now?: Date;
  readonly detail?: string;
}): Promise<ApprovalRequest>;
export declare function resolveApproval(store: ApprovalStore, token: string, verdict: ApprovalVerdict, options?: {
  readonly requireDistinctApprover?: boolean;
}): Promise<ApprovalRequest>;
export declare function inspectApproval(store: ApprovalStore, token: string, now?: Date): Promise<ApprovalInspectResult>;
export declare function readApprovalHeader(headers: Headers | {
  readonly get: (name: string) => string | null;
}): string | undefined;
export declare function resumeFromHeader(store: ApprovalStore, headers: Headers | {
  readonly get: (name: string) => string | null;
}, now?: Date): Promise<ApprovalInspectResult>;
//#endregion
//#region src/approvals/store.d.ts
type MemoryApprovalStore = ApprovalStore & {
  readonly ttl: number;
};
export declare function memoryApprovalStore(options?: {
  readonly ttl?: number;
}): MemoryApprovalStore;
//#endregion
export type { ApprovalInspectResult, ApprovalListFilter, ApprovalRequest, ApprovalResumeFailure, ApprovalStatus, ApprovalStore, ApprovalSubjectSummary, ApprovalVerdict, ApprovalsHandlerOptions, MemoryApprovalStore };