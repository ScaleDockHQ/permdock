import { d as Subject, l as Membership } from "../subject-BcgWbogX.js";
import { r as Permission } from "../permissions-CkmCCiYs.js";
import { a as ApprovalResumeFailure, c as ApprovalSubjectSummary, i as ApprovalRequest, l as ApprovalVerdict, n as ApprovalInspectResult, o as ApprovalStatus, r as ApprovalListFilter, s as ApprovalStore, t as APPROVAL_HEADER, u as DEFAULT_APPROVAL_TTL_MS } from "../types-D19MSDwi.js";
import { n as Decision } from "../decision-CH_azeep.js";
import { h as TokenSigner } from "../interfaces-BPpihPRB.js";
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
export { APPROVAL_HEADER, type ApprovalInspectResult, type ApprovalListFilter, type ApprovalRequest, type ApprovalResumeFailure, type ApprovalStatus, type ApprovalStore, type ApprovalSubjectSummary, type ApprovalVerdict, type ApprovalsHandlerOptions, DEFAULT_APPROVAL_TTL_MS, type MemoryApprovalStore };