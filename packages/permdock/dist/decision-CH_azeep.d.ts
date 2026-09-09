import { d as Subject } from "./subject-BcgWbogX.js";
import { r as Grant } from "./policy-CIG-jCsG.js";
import { r as Permission } from "./permissions-CkmCCiYs.js";
//#region src/core/decision.d.ts
type DenialReason = "no-grant" | "condition" | "deny" | "closure-error" | "opaque-condition" | "anonymous" | "not-delegated" | "no-delegation" | "insufficient-user-authentication" | "limit" | "validation" | "tenant-mismatch" | "no-membership" | "scope" | "expired-membership" | "unknown-role" | "approval";
type Denial = {
  readonly role: string | null;
  readonly reason: DenialReason;
  readonly detail?: unknown;
};
type MatchedGrant = {
  readonly role: string;
  readonly permission: string;
  readonly where?: Grant["where"];
  readonly check?: Grant["check"];
  readonly approval?: "human";
};
type GrantedDecision = {
  readonly outcome: "granted";
  readonly subject: Subject & {
    readonly principal: NonNullable<Subject["principal"]>;
  };
  readonly matched: MatchedGrant;
  readonly token: string;
};
type DeniedDecision = {
  readonly outcome: "denied";
  readonly denials: readonly Denial[];
  readonly alternatives: readonly Permission[];
};
type ApprovalRequiredDecision = {
  readonly outcome: "approval-required";
  readonly grant: MatchedGrant;
  readonly reason: "human";
  readonly token: string;
};
type Decision = GrantedDecision | DeniedDecision | ApprovalRequiredDecision;
//#endregion
export { DeniedDecision as a, DenialReason as i, Decision as n, GrantedDecision as o, Denial as r, MatchedGrant as s, ApprovalRequiredDecision as t };