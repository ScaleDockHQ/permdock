import { d as Subject } from "../subject-BcgWbogX.js";
import { B as Decision, J as Permission } from "../policy-CrXDbTAD.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-VFloA7GW.js";
import { a as createPermDock, c as InvalidSignatureError, d as WebBotAuthKeys, f as WebBotAuthOptions, h as invalidSignatureResponse, i as ServerPermDockOptions, l as WebBotAuthJwk, m as invalidSignatureProblem, n as OpenApiHooks, o as createEvaluationsHandler, p as discoverViaSignatureAgent, r as ServerPermDock, s as DiscoverViaSignatureAgentOptions, t as Guard, u as WebBotAuthKeyLookup } from "../create-DOYrE6Dq.js";
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
export { type DiscoverViaSignatureAgentOptions, type Guard, InvalidSignatureError, type OpenApiHooks, PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, type ServerPermDock, type ServerPermDockOptions, type WebBotAuthJwk, type WebBotAuthKeyLookup, type WebBotAuthKeys, type WebBotAuthOptions, createEvaluationsHandler, createEvaluationsHandler as createHandler, createPermDock, discoverViaSignatureAgent, invalidSignatureProblem, invalidSignatureResponse };