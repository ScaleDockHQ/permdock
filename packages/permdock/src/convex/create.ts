import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";
import type {
  ConvexCtxLike,
  ConvexHandler,
  ConvexPermDock,
  ConvexPermDockCtx,
  ConvexPermDockOptions,
} from "./types.ts";

import { actorFrom, tenantScope } from "../core/adapter-context.ts";
import { compact } from "../core/compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from "../core/errors.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createPermDock as createCore } from "../core/permdock.ts";

/** Convex's runtime sends `data` to the client only for an error carrying this symbol. */
const CONVEX_ERROR = Symbol.for("ConvexError");

export class ConvexError extends Error {
  public override readonly name = "ConvexError";
  public readonly data: ReturnType<PermDockDeniedError["toProblemDetails"]>;

  public constructor(
    data: ReturnType<PermDockDeniedError["toProblemDetails"]>,
  ) {
    super(data.detail);
    this.data = data;
    Object.defineProperty(this, CONVEX_ERROR, { value: true });
  }
}

function toConvexError(error: unknown): unknown {
  if (
    error instanceof PermDockDeniedError ||
    error instanceof PermDockApprovalRequiredError ||
    error instanceof PermDockValidationError
  ) {
    return new ConvexError(error.toProblemDetails());
  }
  return error;
}

export function createPermDock<
  TCtx,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ConvexPermDockOptions<TCtx, TUser>,
): ConvexPermDock<TCtx, V> {
  const withPermDock = <TArgs, TResult>(
    handler: ConvexHandler<TCtx, TArgs, TResult, V>,
  ): ((ctx: TCtx, args: TArgs) => Promise<TResult>) => {
    return async (ctx: TCtx, args: TArgs): Promise<TResult> => {
      let user: TUser | null = null;
      try {
        user = await options.subject(ctx);
      } catch {
        user = null;
      }
      const permdock = await createCore(
        policy,
        user,
        compact({
          tenant: (await tenantScope(options.tenant, ctx)).tenant,
          ...instanceOptions(options),
          actor: await actorFrom(options.actor, ctx),
        }),
      );
      // SAFETY: the spread keeps every TCtx field and adds the permdock instance built above.
      const next = { ...ctx, permdock } as ConvexPermDockCtx<TCtx, V>;
      try {
        return await handler(next, args);
      } catch (error) {
        throw toConvexError(error);
      }
    };
  };

  const snapshotQuery = (snapshotOptions?: {
    readonly include?: readonly Permission[];
  }): unknown => {
    const handler = withPermDock(
      (ctx: ConvexPermDockCtx<TCtx>, args: Record<string, never>) => {
        void args;
        return Promise.resolve(
          ctx.permdock.snapshot(compact({ include: snapshotOptions?.include })),
        );
      },
    );
    // SAFETY: Convex calls the handler with the app's own query context, which TCtx describes.
    const definition = {
      args: {},
      handler: (
        ctx: ConvexCtxLike,
        args: Record<string, never>,
      ): Promise<unknown> => handler(ctx as TCtx, args),
    };
    if (options.query !== undefined) {
      return options.query(definition);
    }
    return definition;
  };

  return { withPermDock, snapshotQuery };
}
