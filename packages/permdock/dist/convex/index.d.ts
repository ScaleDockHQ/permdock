import { J as Permission, o as Policy } from "../policy-B9ZJilUm.js";
import { i as ProblemDetails, n as PermDockDeniedError } from "../errors-ojKVwrw-.js";
import { r as PermDock } from "../permdock-Dzaw5_Cl.js";
//#region src/convex/types.d.ts
type ConvexCtxLike = {
  readonly auth?: {
    readonly getUserIdentity?: () => Promise<unknown>;
  };
  readonly db?: unknown;
};
type ConvexPermDockCtx<TCtx> = TCtx & {
  readonly permdock: PermDock;
};
type ConvexSubject<TCtx> = (ctx: TCtx) => unknown;
type ConvexQueryBuilder = (definition: {
  readonly args: Record<string, never>;
  readonly handler: (ctx: ConvexCtxLike, args: Record<string, never>) => unknown;
}) => unknown;
type ConvexPermDockOptions<TCtx> = {
  readonly subject: ConvexSubject<TCtx>;
  readonly query?: ConvexQueryBuilder;
};
type ConvexHandler<TCtx, TArgs, TResult> = (ctx: ConvexPermDockCtx<TCtx>, args: TArgs) => TResult | Promise<TResult>;
type ConvexErrorData = ProblemDetails;
type ConvexPermDock<TCtx> = {
  readonly withPermDock: <TArgs, TResult>(handler: ConvexHandler<TCtx, TArgs, TResult>) => (ctx: TCtx, args: TArgs) => Promise<TResult>;
  readonly snapshotQuery: (options?: {
    readonly include?: readonly Permission[];
  }) => unknown;
};
//#endregion
//#region src/convex/create.d.ts
export declare class ConvexError extends Error {
  override readonly name = "ConvexError";
  readonly data: ReturnType<PermDockDeniedError["toProblemDetails"]>;
  constructor(data: ReturnType<PermDockDeniedError["toProblemDetails"]>);
}
export declare function createPermDock<TCtx, TUser>(policy: Policy<TUser>, options: ConvexPermDockOptions<TCtx>): ConvexPermDock<TCtx>;
//#endregion
export type { ConvexCtxLike, ConvexErrorData, ConvexHandler, ConvexPermDock, ConvexPermDockCtx, ConvexPermDockOptions, ConvexQueryBuilder, ConvexSubject };