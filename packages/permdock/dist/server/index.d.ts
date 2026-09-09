import { d as Subject } from "../subject-BcgWbogX.js";
import { v as Permission } from "../policy-DsqYfECx.js";
import { n as Decision } from "../decision-C6A-71_M.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-DT0uCKV-.js";
import { a as createPermDock, i as ServerPermDockOptions, n as OpenApiHooks, o as createEvaluationsHandler, r as ServerPermDock, t as Guard } from "../create-BwhCpCoE.js";
//#region src/server/problem.d.ts
export declare const PROBLEM_BASE = "https://permdock.dev/problems";
export declare function wwwAuthenticate(decision: Decision, permission: Permission | undefined): string | undefined;
export declare function problemResponse(details: ProblemDetails, permission?: Permission, decision?: Decision): Response;
export declare function validationProblem(detail: string): Response;
export declare function problemFromDecision(decision: Decision, permission: Permission, subject: Subject, options?: {
  readonly instance?: string;
  readonly base?: string;
}): Response;
//#endregion
export { type Guard, type OpenApiHooks, PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, type ServerPermDock, type ServerPermDockOptions, createEvaluationsHandler, createEvaluationsHandler as createHandler, createPermDock };