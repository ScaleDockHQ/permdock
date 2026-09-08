import { o as Policy, v as Permission } from "./policy-CL40bNGn.js";
import { s as ApprovalStore } from "./types-DwRNNTg4.js";
import { n as Decision } from "./decision-Cjr-7xoX.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "./interfaces-DMSVa7et.js";
import { r as PermDock } from "./permdock-CSDl61mA.js";
//#region src/server/evaluations.d.ts
declare function createEvaluationsHandler(options: {
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
declare function createPermDock(policy: Policy, options: ServerPermDockOptions & {
  readonly wrap?: (dock: PermDock) => PermDock;
}): ServerPermDock;
//#endregion
export { createPermDock as a, ServerPermDockOptions as i, OpenApiHooks as n, createEvaluationsHandler as o, ServerPermDock as r, Guard as t };