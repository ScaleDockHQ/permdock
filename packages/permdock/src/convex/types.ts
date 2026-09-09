import type { ProblemDetails } from '../core/errors.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';

export type ConvexCtxLike = {
  readonly auth?: {
    readonly getUserIdentity?: () => Promise<unknown>;
  };
  readonly db?: unknown;
};

export type ConvexPermDockCtx<TCtx> = TCtx & {
  readonly permdock: PermDock;
};

export type ConvexSubject<TCtx, TUser = unknown> = (
  ctx: TCtx,
) => TUser | Promise<TUser>;

export type ConvexQueryBuilder = (definition: {
  readonly args: Record<string, never>;
  readonly handler: (
    ctx: ConvexCtxLike,
    args: Record<string, never>,
  ) => unknown;
}) => unknown;

export type ConvexPermDockOptions<TCtx, TUser = unknown> = {
  readonly subject: ConvexSubject<TCtx, TUser>;
  readonly query?: ConvexQueryBuilder;
};

export type ConvexHandler<TCtx, TArgs, TResult> = (
  ctx: ConvexPermDockCtx<TCtx>,
  args: TArgs,
) => TResult | Promise<TResult>;

export type ConvexErrorData = ProblemDetails;

export type ConvexPermDock<TCtx> = {
  readonly withPermDock: <TArgs, TResult>(
    handler: ConvexHandler<TCtx, TArgs, TResult>,
  ) => (ctx: TCtx, args: TArgs) => Promise<TResult>;
  readonly snapshotQuery: (options?: {
    readonly include?: readonly Permission[];
  }) => unknown;
};
