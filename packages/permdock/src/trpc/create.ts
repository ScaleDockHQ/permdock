import {
  TRPCError,
  isTrackedEnvelope,
  type AnyTRPCMiddlewareFunction,
} from "@trpc/server";

import type { ApprovalStore } from "../approvals/types.ts";
import type { PermDockRevokedError } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type {
  OpenApiHooks,
  TenantOption,
  TenantScope,
} from "../server/create.ts";
import type { StreamProtectOptions } from "../server/stream.ts";
import type { WebBotAuthVerifier } from "../server/web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createServerKernel, tenantScope } from "../server/create.ts";
import { problemMessage, requestFromContext } from "../server/http.ts";
import { problemFromError } from "../server/map-error.ts";
import {
  guardIterable,
  isAsyncIterable,
  reloadAfter,
} from "../server/stream.ts";
import { invalidSignatureResponse } from "../server/web-bot-auth.ts";

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
> = InstanceOptions & {
  readonly subject: (opts: TrpcMiddlewareOpts<TCtx>) => TUser | Promise<TUser>;
  /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
  readonly actor?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  readonly tenant?: TenantOption<TrpcMiddlewareOpts<TCtx>>;
  /** The Web `Request` behind a context; defaults to `ctx.request` or `ctx.req`. */
  readonly request?: (ctx: TCtx) => Request | null | undefined;
  readonly store?: ApprovalStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
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

function trpcCode(
  status: number,
):
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE"
  | "FORBIDDEN" {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "FORBIDDEN";
  }
}

/** A `TRPCError` for a revoked subscription; the Problem Details body rides on `cause`. */
function trpcErrorFrom(error: PermDockRevokedError): TRPCError {
  const problem = error.toProblemDetails();
  const cause: Record<PropertyKey, unknown> = { ...problem };
  Object.defineProperty(cause, PROBLEM, { value: true, enumerable: true });
  return new TRPCError({
    code: trpcCode(problem.status),
    message: error.code,
    cause,
  });
}

async function throwTrpcError(response: Response): Promise<never> {
  let cause: unknown;
  try {
    cause = await response.json();
  } catch {
    cause = { status: response.status };
  }
  if (cause !== null && typeof cause === "object") {
    Object.defineProperty(cause, PROBLEM, { value: true, enumerable: true });
  }
  const code = trpcCode(response.status);
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
  const optsByRequest = new WeakMap<Request, TrpcMiddlewareOpts<TCtx>>();
  const requestByCtx = new WeakMap<object, Request>();
  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const opts = optsByRequest.get(request);
        return opts === undefined ? null : options.subject(opts);
      },
      actor:
        options.actor === undefined
          ? undefined
          : (request: Request): unknown => {
              const opts = optsByRequest.get(request);
              return opts === undefined ? undefined : options.actor?.(opts);
            },
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: "trpc",
      wrap: options.otel,
    }),
  );

  const requestOf = (ctx: TCtx): Request | undefined => {
    if (options.request !== undefined) {
      try {
        return options.request(ctx) ?? undefined;
      } catch {
        return undefined;
      }
    }
    // SAFETY: tRPC always passes an object context; TCtx is unconstrained only for inference.
    return requestFromContext(ctx as object);
  };

  /**
   * One `Request` per HTTP request, shared by every procedure in a batch. The
   * subject reads the first procedure's opts; the tenant is resolved from each
   * procedure's own opts in `scopeOf`, never through the shared `Request`.
   */
  const bind = (opts: TrpcMiddlewareOpts<TCtx>): Request => {
    // SAFETY: tRPC always passes an object context; TCtx is unconstrained only for inference.
    const ctx = opts.ctx as object;
    const hit = requestByCtx.get(ctx);
    if (hit !== undefined) {
      return hit;
    }
    const request =
      requestOf(opts.ctx) ??
      new Request(`http://localhost/trpc/${opts.path}`, { method: "POST" });
    requestByCtx.set(ctx, request);
    if (!optsByRequest.has(request)) {
      optsByRequest.set(request, opts);
    }
    return request;
  };

  const scopeOf = (opts: TrpcMiddlewareOpts<TCtx>): Promise<TenantScope> =>
    tenantScope(options.tenant, opts);

  const attach = (ctx: object, request: Request): void => {
    requestByCtx.set(ctx, request);
  };

  // SAFETY: the function has tRPC's middleware call shape; its generics cannot be inferred from it.
  const permdock = (): TrpcMiddleware =>
    (async (opts: TrpcMiddlewareOpts<TCtx>): Promise<unknown> => {
      const request = bind(opts);
      let instance: PermDock;
      try {
        instance = await kernel.permdock(request, await scopeOf(opts));
      } catch (error) {
        const response = invalidSignatureResponse(error);
        if (response !== undefined) {
          return throwTrpcError(response);
        }
        throw error;
      }
      const nextCtx = { ...opts.ctx, permdock: instance };
      attach(nextCtx, request);
      return mapDownstream(await opts.next({ ctx: nextCtx }));
    }) as TrpcMiddleware;

  const connection = async (
    opts: TrpcMiddlewareOpts<TCtx>,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> =>
    kernel.connection(bind(opts), connectionOptions, await scopeOf(opts));

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
    const conn = await connection(
      opts,
      permission === null ? {} : compact({ permission, data: loadData }),
    );
    // SAFETY: isAsyncIterable confirmed data above.
    return {
      ...result,
      data: guardIterable(
        (result as { readonly data: AsyncIterable<unknown> }).data,
        conn,
        compact({
          items: protectOptions?.items,
          unwrap: (item: unknown): unknown =>
            isTrackedEnvelope(item) ? item[1] : item,
          onRevoked: trpcErrorFrom,
        }),
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

  const evaluations = kernel.permdockHandler((request) => {
    const opts = optsByRequest.get(request);
    return opts === undefined ? { tenant: undefined } : scopeOf(opts);
  });

  const permdockHandler = (request: Request): Promise<Response> => {
    // SAFETY: the handler route runs outside tRPC, so its only context is the request as req.
    const opts = {
      ctx: { req: request } as TCtx,
      path: "permdock",
      type: "unknown",
      next: (nextOpts?: { readonly ctx: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { ctx: { req: request } as TCtx }),
    } satisfies TrpcMiddlewareOpts<TCtx>;
    bind(opts);
    return Promise.resolve(
      request.method === "GET"
        ? evaluations.GET(request)
        : evaluations.POST(request),
    );
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
