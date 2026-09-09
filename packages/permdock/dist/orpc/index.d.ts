import { o as Policy } from "../policy-CIG-jCsG.js";
import { r as Permission } from "../permissions-CkmCCiYs.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-BPpihPRB.js";
import { n as OpenApiHooks } from "../create-BJhgSpGs.js";
import { AnyMiddleware } from "@orpc/server";
//#region src/orpc/create.d.ts
type OrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly context: TCtx;
  readonly input?: TInput;
  readonly path?: readonly string[];
  readonly next: (opts?: {
    readonly context: TCtx;
  }) => Promise<unknown>;
};
type OrpcMiddleware = AnyMiddleware;
type OrpcPermDockOptions<TCtx = object> = {
  readonly subject: (opts: OrpcMiddlewareOpts<TCtx>) => unknown;
  readonly tenant?: string | ((opts: OrpcMiddlewareOpts<TCtx>) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type OrpcOpenApiHooks<TCtx = object> = {
  readonly protect: (permission: Permission, loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown) => OrpcMiddleware;
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly "x-permdock-permissions": readonly string[];
  };
  readonly securitySchemes: OpenApiHooks["securitySchemes"];
};
type OrpcPermDock<TCtx = object> = {
  readonly permdock: () => OrpcMiddleware;
  readonly protect: (permission: Permission, loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown) => OrpcMiddleware;
  readonly permdockHandler: (request: Request) => Promise<Response>;
  readonly openapi: OrpcOpenApiHooks<TCtx>;
};
export declare function createPermDock<TCtx = object>(policy: Policy, options: OrpcPermDockOptions<TCtx>): OrpcPermDock<TCtx>;
//#endregion
export type { OrpcMiddleware, OrpcMiddlewareOpts, OrpcOpenApiHooks, OrpcPermDock, OrpcPermDockOptions };