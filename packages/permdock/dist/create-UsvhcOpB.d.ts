import { c as JsonWebKeyLike } from "./subject-BcgWbogX.js";
import { B as Decision, E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "./policy-B9ZJilUm.js";
import { s as ApprovalStore } from "./types-D19MSDwi.js";
import { r as PermDock } from "./permdock-Dzaw5_Cl.js";
//#region src/server/web-bot-auth.d.ts
type WebBotAuthJwk = JsonWebKeyLike & {
  readonly kid?: string;
  readonly crv?: string;
};
type WebBotAuthKeyLookup = (input: {
  readonly request: Request;
  readonly keyid: string;
  readonly agent: string | undefined;
}) => WebBotAuthJwk | undefined | Promise<WebBotAuthJwk | undefined>;
type WebBotAuthKeys = {
  readonly lookup: WebBotAuthKeyLookup;
};
type WebBotAuthOptions = {
  readonly verify?: boolean;
  readonly keys: WebBotAuthKeys | WebBotAuthKeyLookup;
  readonly required?: boolean;
  readonly maxAge?: number;
};
type DiscoverViaSignatureAgentOptions = {
  readonly allow: readonly string[];
  readonly fetch?: typeof fetch;
};
declare class InvalidSignatureError extends Error {
  override readonly name: "InvalidSignatureError";
  readonly response: Response;
  constructor(response: Response);
}
declare function invalidSignatureResponse(error: unknown): Response | undefined;
declare function invalidSignatureProblem(detail: string, base?: string): Response;
declare function discoverViaSignatureAgent(options: DiscoverViaSignatureAgentOptions): WebBotAuthKeys;
//#endregion
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
  readonly webBotAuth?: WebBotAuthOptions;
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
export { createPermDock as a, InvalidSignatureError as c, WebBotAuthKeys as d, WebBotAuthOptions as f, invalidSignatureResponse as h, ServerPermDockOptions as i, WebBotAuthJwk as l, invalidSignatureProblem as m, OpenApiHooks as n, createEvaluationsHandler as o, discoverViaSignatureAgent as p, ServerPermDock as r, DiscoverViaSignatureAgentOptions as s, Guard as t, WebBotAuthKeyLookup as u };