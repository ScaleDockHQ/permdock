import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { o as Policy, v as Permission } from "../policy-Dvre0Da9.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { n as OpenApiHooks } from "../create-KZgWsU_G.js";
import { AnyTRPCMiddlewareFunction } from "@trpc/server";
//#region src/trpc/create.d.ts
type TrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly ctx: TCtx;
  readonly input?: TInput;
  readonly path: string;
  readonly type: string;
  readonly next: (opts?: {
    readonly ctx: TCtx;
  }) => Promise<unknown>;
};
type TrpcMiddleware = AnyTRPCMiddlewareFunction;
type TrpcPermDockOptions<TCtx = object> = {
  readonly subject: (opts: TrpcMiddlewareOpts<TCtx>) => unknown;
  readonly tenant?: string | ((opts: TrpcMiddlewareOpts<TCtx>) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type TrpcOpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly openapi: {
      readonly protect: true;
      readonly security: readonly Record<string, readonly string[]>[];
      readonly "x-permdock-permissions": readonly string[];
    };
  };
  readonly securitySchemes: OpenApiHooks["securitySchemes"];
};
type TrpcPermDock<TCtx = object> = {
  readonly permdock: () => TrpcMiddleware;
  readonly protect: (permission: Permission, loadData?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown) => TrpcMiddleware;
  readonly permdockHandler: (request: Request) => Promise<Response>;
  readonly openapi: TrpcOpenApiHooks;
  readonly errorFormatter: <TShape extends {
    readonly data: object;
  }>(opts: {
    readonly shape: TShape;
    readonly error: {
      readonly cause?: unknown;
    };
  }) => TShape;
};
export declare function errorFormatter<TShape extends {
  readonly data: object;
}>(opts: {
  readonly shape: TShape;
  readonly error: {
    readonly cause?: unknown;
  };
}): TShape;
export declare function createPermDock<TCtx = object>(policy: Policy, options: TrpcPermDockOptions<TCtx>): TrpcPermDock<TCtx>;
//#endregion
export type { TrpcMiddleware, TrpcMiddlewareOpts, TrpcOpenApiHooks, TrpcPermDock, TrpcPermDockOptions };