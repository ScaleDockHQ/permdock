import { E as RoleSource, J as Permission, T as MembershipSource, k as SnapshotSource, o as Policy, y as DecisionSink } from "../policy-B9ZJilUm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { f as WebBotAuthOptions, n as OpenApiHooks } from "../create-UsvhcOpB.js";
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
  readonly webBotAuth?: WebBotAuthOptions;
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