import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type {
  ConvexCtxLike,
  ConvexHandler,
  ConvexPermDock,
  ConvexPermDockCtx,
  ConvexPermDockOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from '../core/errors.ts';
import { createPermDock as createCore } from '../core/permdock.ts';

export class ConvexError extends Error {
  public override readonly name = 'ConvexError';
  public readonly data: ReturnType<PermDockDeniedError['toProblemDetails']>;

  public constructor(
    data: ReturnType<PermDockDeniedError['toProblemDetails']>,
  ) {
    super(data.detail);
    this.data = data;
  }
}

function toConvexError(error: unknown): unknown {
  if (
    error instanceof PermDockDeniedError ||
    error instanceof PermDockApprovalRequiredError
  ) {
    return new ConvexError(error.toProblemDetails());
  }
  return error;
}

export function createPermDock<TCtx, TUser>(
  policy: Policy<TUser>,
  options: ConvexPermDockOptions<TCtx>,
): ConvexPermDock<TCtx> {
  const withPermDock = <TArgs, TResult>(
    handler: ConvexHandler<TCtx, TArgs, TResult>,
  ): ((ctx: TCtx, args: TArgs) => Promise<TResult>) => {
    return async (ctx: TCtx, args: TArgs): Promise<TResult> => {
      let user: unknown = null;
      try {
        user = await options.subject(ctx);
      } catch {
        user = null;
      }
      const dock = await createCore(policy as Policy, user);
      const next = { ...ctx, permdock: dock } as ConvexPermDockCtx<TCtx> & {
        readonly permdock: PermDock;
      };
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
