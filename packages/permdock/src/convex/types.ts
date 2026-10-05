import type { ProblemDetails } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { PolicyVocabulary } from "../core/policy.ts";

export type ConvexCtxLike = {
  readonly auth?: {
    readonly getUserIdentity?: () => Promise<unknown>;
  };
  readonly db?: unknown;
};

export type ConvexPermDockCtx<
  TCtx,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TCtx & {
  readonly permdock: PermDock<V>;
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

export type ConvexPermDockOptions<TCtx, TUser = unknown> = InstanceOptions & {
  readonly subject: ConvexSubject<TCtx, TUser>;
  readonly query?: ConvexQueryBuilder;
};

export type ConvexHandler<
  TCtx,
  TArgs,
  TResult,
  V extends PolicyVocabulary = PolicyVocabulary,
> = (
  ctx: ConvexPermDockCtx<TCtx, V>,
  args: TArgs,
) => TResult | Promise<TResult>;

export type ConvexErrorData = ProblemDetails;

export type ConvexPermDock<
  TCtx,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly withPermDock: <TArgs, TResult>(
    handler: ConvexHandler<TCtx, TArgs, TResult, V>,
  ) => (ctx: TCtx, args: TArgs) => Promise<TResult>;
  readonly snapshotQuery: (options?: {
    readonly include?: readonly Permission[];
  }) => unknown;
};
