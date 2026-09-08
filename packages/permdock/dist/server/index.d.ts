import { g as Subject } from "../ast-BtUySn6K.js";
import { v as Permission } from "../policy-CL40bNGn.js";
import { n as Decision } from "../decision-Cjr-7xoX.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-DZNvOxVD.js";
import { a as createPermDock, i as ServerPermDockOptions, n as OpenApiHooks, o as createEvaluationsHandler, r as ServerPermDock, t as Guard } from "../create-YivrumEU.js";
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