import { O as Subject, l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-D45oN5-b.js";
import { s as ApprovalStore } from "../types-DcgC3zN4.js";
import { T as Permission, n as Decision, p as Policy } from "../decision-JylG_mtz.js";
import { a as PermDock } from "../from-snapshot-g-xOl0Tw.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-Dh0xCVJ8.js";
//#region src/server/evaluations.d.ts
export declare function createEvaluationsHandler(options: {
  readonly policy: Policy;
  readonly resolve?: (request: Request) => Promise<PermDock>;
  readonly getPermDock?: (query?: {
    readonly tenant?: string;
  }) => Promise<PermDock>;
  readonly store?: ApprovalStore;
  readonly adapter?: string;
}): {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
};
//#endregion
//#region src/server/create.d.ts
type ServerPermDockOptions = {
  readonly subject: (request: Request) => unknown;
  readonly actor?: (request: Request) => unknown;
  readonly tenant?: string | ((request: Request) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly problem?: {
    readonly base?: string;
  };
};
type Guard<T = unknown> = {
  readonly ok: true;
  readonly permdock: PermDock;
  readonly decision: Extract<Decision, {
    readonly outcome: "granted";
  }>;
  readonly data: T;
} | {
  readonly ok: false;
  readonly response: Response;
};
type OpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly "x-permdock-permissions": readonly string[];
  };
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
};
type ServerPermDock = {
  readonly permdock: (request: Request) => Promise<PermDock>;
  readonly protect: <T = unknown>(permission: Permission, loadData?: (request: Request) => T | null | undefined | Promise<T | null | undefined>) => (request: Request) => Promise<Guard<T>>;
  readonly problem: (decision: Decision, init?: {
    readonly permission?: Permission;
    readonly instance?: string;
  }) => Response;
  readonly openapi: OpenApiHooks;
  readonly handler: () => ReturnType<typeof createEvaluationsHandler>;
};
export declare function createPermDock(policy: Policy, options: ServerPermDockOptions): ServerPermDock;
//#endregion
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
export { type Guard, type OpenApiHooks, PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, type ServerPermDock, type ServerPermDockOptions, createEvaluationsHandler as createHandler };