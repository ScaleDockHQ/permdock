import {
  TRPCError,
  isTrackedEnvelope,
  type AnyTRPCMiddlewareFunction,
} from "@trpc/server";

import type { PermDockRevokedError } from "../core/errors.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type { OpenApiHooks } from "../server/create.ts";
import type { StreamProtectOptions } from "../server/stream.ts";

import { attached } from "../server/bind.ts";
import { problemMessage } from "../server/http.ts";
import { problemFromError } from "../server/map-error.ts";
import {
  bindRpcKernel,
  guardStream,
  problemBody,
  rpcCode,
} from "../server/rpc.ts";
import { isAsyncIterable, reloadAfter } from "../server/stream.ts";

export type TrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly ctx: TCtx;
  readonly input?: TInput;
  readonly path: string;
  readonly type: string;
  readonly next: (opts?: { readonly ctx: TCtx }) => Promise<unknown>;
};

export type TrpcMiddleware = AnyTRPCMiddlewareFunction;

export type TrpcPermDockOptions<
  TCtx = object,
  TUser = unknown,
> = ServerAdapterOptions<TrpcMiddlewareOpts<TCtx>, TUser> & {
  /** The Web `Request` behind a context; defaults to `ctx.request` or `ctx.req`. */
  readonly request?: (ctx: TCtx) => Request | null | undefined;
  /** Ends or revalidates open subscriptions. */
  readonly revocations?: RevocationFeed;
};

export type TrpcOpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly openapi: {
      readonly protect: true;
      readonly security: readonly Record<string, readonly string[]>[];
      readonly "x-permdock-permissions": readonly string[];
    };
  };
  readonly securitySchemes: OpenApiHooks["securitySchemes"];
};

export type TrpcPermDock<TCtx = object> = {
  readonly permdock: () => TrpcMiddleware;
  readonly protect: (
    permission: Permission | null,
    loadData?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ) => TrpcMiddleware;
  /** A long-lived connection for the request behind `ctx`. */
  readonly connection: (
    opts: TrpcMiddlewareOpts<TCtx>,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly permdockHandler: (request: Request) => Promise<Response>;
  readonly openapi: TrpcOpenApiHooks;
  readonly errorFormatter: <TShape extends { readonly data: object }>(opts: {
    readonly shape: TShape;
    readonly error: { readonly cause?: unknown };
  }) => TShape;
};

const PROBLEM = Symbol.for("permdock.problem");

/** A `TRPCError` for a revoked subscription; the Problem Details body rides on `cause`. */
function trpcErrorFrom(error: PermDockRevokedError): TRPCError {
  const problem = error.toProblemDetails();
  const cause: Record<PropertyKey, unknown> = { ...problem };
  Object.defineProperty(cause, PROBLEM, { value: true, enumerable: true });
  return new TRPCError({
    code: rpcCode(problem.status),
    message: error.code,
    cause,
  });
}

async function throwTrpcError(response: Response): Promise<never> {
  const cause = await problemBody(response);
  if (cause !== null && typeof cause === "object") {
    Object.defineProperty(cause, PROBLEM, { value: true, enumerable: true });
  }
  const code = rpcCode(response.status);
  throw new TRPCError({
    code,
    message: problemMessage(cause, code),
    cause,
  });
}

/**
 * A PermDock error thrown further down (an `assert` in a resolver) arrives as
 * a failed middleware result; it becomes the same TRPCError `protect` throws.
 */
function mapDownstream(result: unknown): Promise<unknown> {
  // SAFETY: checked to be a non-null object first; ok is only compared.
  if (
    result === null ||
    typeof result !== "object" ||
    (result as { readonly ok?: unknown }).ok !== false
  ) {
    return Promise.resolve(result);
  }
  // SAFETY: the check above returned unless result is a non-null object; error is tested below.
  const error = (result as { readonly error?: unknown }).error;
  const cause =
    error instanceof TRPCError && error.code === "INTERNAL_SERVER_ERROR"
      ? error.cause
      : undefined;
  const mapped = problemFromError(cause);
  return mapped === undefined
    ? Promise.resolve(result)
    : throwTrpcError(mapped);
}

export function errorFormatter<TShape extends { readonly data: object }>(opts: {
  readonly shape: TShape;
  readonly error: { readonly cause?: unknown };
}): TShape {
  const cause = opts.error.cause;
  if (cause === null || typeof cause !== "object" || !(PROBLEM in cause)) {
    return opts.shape;
  }
  // SAFETY: checked above to be a non-null object carrying the PROBLEM brand.
  const { [PROBLEM]: _brand, ...problem } = cause as Record<
    PropertyKey,
    unknown
  >;
  return {
    ...opts.shape,
    data: { ...opts.shape.data, ...problem },
  };
}

export function createPermDock<
  TCtx = object,
  TUser = unknown,
  TPrincipal extends Principal = Principal,
>(
  policy: Policy<TUser, TPrincipal>,
  options: TrpcPermDockOptions<TCtx, TUser>,
): TrpcPermDock<TCtx> {
  const { kernel, bind, attach, scopeOf, connection, evaluate } = bindRpcKernel(
    policy,
    options,
    "trpc",
    (opts: TrpcMiddlewareOpts<TCtx>) => opts.ctx,
    (opts) => opts.path,
  );

  // SAFETY: the function has tRPC's middleware call shape; its generics cannot be inferred from it.
  const permdock = (): TrpcMiddleware =>
    (async (opts: TrpcMiddlewareOpts<TCtx>): Promise<unknown> => {
      const request = bind(opts);
      const instance = await attached(async () =>
        kernel.permdock(request, await scopeOf(opts)),
      );
      if (!instance.ok) {
        return throwTrpcError(instance.response);
      }
      const nextCtx = { ...opts.ctx, permdock: instance.permdock };
      attach(nextCtx, request);
      return mapDownstream(await opts.next({ ctx: nextCtx }));
    }) as TrpcMiddleware;

  /** Wraps a subscription's iterable so revocation ends it and unreadable items drop. */
  const guardSubscription = async (
    result: unknown,
    opts: TrpcMiddlewareOpts<TCtx>,
    permission: Permission | null,
    loadData: (() => unknown) | undefined,
    protectOptions: StreamProtectOptions | undefined,
  ): Promise<unknown> => {
    // SAFETY: checked to be a non-null object first; ok is only compared and data only tested.
    if (
      result === null ||
      typeof result !== "object" ||
      (result as { readonly ok?: unknown }).ok !== true ||
      !isAsyncIterable((result as { readonly data?: unknown }).data)
    ) {
      return result;
    }
    // SAFETY: isAsyncIterable confirmed data above.
    return {
      ...result,
      data: await guardStream(
        (result as { readonly data: AsyncIterable<unknown> }).data,
        (connectionOptions) => connection(opts, connectionOptions),
        permission,
        loadData,
        protectOptions,
        {
          unwrap: (item: unknown): unknown =>
            isTrackedEnvelope(item) ? item[1] : item,
          onRevoked: trpcErrorFrom,
        },
      ),
    };
  };

  const protect = (
    permission: Permission | null,
    loadData?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ): TrpcMiddleware =>
    // SAFETY: the function has tRPC's middleware call shape; its generics cannot be inferred from it.
    (async (opts: TrpcMiddlewareOpts<TCtx>): Promise<unknown> => {
      const request = bind(opts);
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(opts),
        protectOptions,
      )(request, await scopeOf(opts));
      if (guard.ok) {
        const nextCtx = {
          ...opts.ctx,
          permdock: guard.permdock,
          permdockData: guard.data,
        };
        attach(nextCtx, request);
        return guardSubscription(
          await mapDownstream(await opts.next({ ctx: nextCtx })),
          opts,
          permission,
          loadData === undefined
            ? undefined
            : reloadAfter(guard.data, (): unknown => loadData(opts)),
          protectOptions,
        );
      }
      return throwTrpcError(guard.response);
    }) as TrpcMiddleware;

  const permdockHandler = (request: Request): Promise<Response> => {
    // SAFETY: the handler route runs outside tRPC, so its only context is the request as req.
    const opts = {
      ctx: { req: request } as TCtx,
      path: "permdock",
      type: "unknown",
      next: (nextOpts?: { readonly ctx: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { ctx: { req: request } as TCtx }),
    } satisfies TrpcMiddlewareOpts<TCtx>;
    return evaluate(request, opts);
  };

  const kernelOpenApi = kernel.openapi;
  const openapi: TrpcOpenApiHooks = {
    security: (permission: Permission) => ({
      openapi: {
        protect: true,
        ...kernelOpenApi.security(permission),
      },
    }),
    securitySchemes: kernelOpenApi.securitySchemes,
  };

  return {
    permdock,
    protect,
    connection,
    permdockHandler,
    openapi,
    errorFormatter,
  };
}
