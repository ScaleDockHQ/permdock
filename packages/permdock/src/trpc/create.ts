import {
  TRPCError,
  isTrackedEnvelope,
  type AnyTRPCMiddlewareFunction,
} from '@trpc/server';

import type { ApprovalStore } from '../approvals/types.ts';
import type { PermDockRevokedError } from '../core/errors.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  EntitlementSource,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { Principal } from '../core/subject.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type { Connection, ConnectionOptions } from '../server/connection.ts';
import type {
  OpenApiHooks,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { StreamProtectOptions } from '../server/stream.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import { problemFromError } from '../server/map-error.ts';
import { guardIterable, isAsyncIterable } from '../server/stream.ts';
import { invalidSignatureResponse } from '../server/web-bot-auth.ts';

export type TrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly ctx: TCtx;
  readonly input?: TInput;
  readonly path: string;
  readonly type: string;
  readonly next: (opts?: { readonly ctx: TCtx }) => Promise<unknown>;
};

export type TrpcMiddleware = AnyTRPCMiddlewareFunction;

export type TrpcPermDockOptions<TCtx = object, TUser = unknown> = {
  readonly subject: (opts: TrpcMiddlewareOpts<TCtx>) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<TrpcMiddlewareOpts<TCtx>>;
  /** The Web `Request` behind a context; defaults to `ctx.request` or `ctx.req`. */
  readonly request?: (ctx: TCtx) => Request | null | undefined;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The object graph for relation grants that walk a parent chain; without it they deny. */
  readonly relations?: RelationSource;
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** Accepted for adapter parity; not read by this adapter. */
  readonly snapshots?: SnapshotSource;
  readonly webBotAuth?: WebBotAuthOptions;
  /** Ends or revalidates open subscriptions. */
  readonly revocations?: RevocationFeed;
};

export type TrpcOpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly openapi: {
      readonly protect: true;
      readonly security: readonly Record<string, readonly string[]>[];
      readonly 'x-permdock-permissions': readonly string[];
    };
  };
  readonly securitySchemes: OpenApiHooks['securitySchemes'];
};

export type TrpcPermDock<TCtx = object> = {
  readonly permdock: () => TrpcMiddleware;
  readonly protect: (
    permission: Permission,
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

function requestFromCtx(ctx: object): Request | undefined {
  if ('request' in ctx) {
    const rec = ctx as { readonly request?: unknown };
    if (rec.request instanceof Request) {
      return rec.request;
    }
  }
  if ('req' in ctx) {
    const rec = ctx as { readonly req?: unknown };
    if (rec.req instanceof Request) {
      return rec.req;
    }
  }
  return undefined;
}

function problemMessage(cause: unknown, fallback: string): string {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'detail' in cause &&
    typeof cause.detail === 'string' &&
    cause.detail.length > 0
  ) {
    return cause.detail;
  }
  return fallback;
}

const PROBLEM = Symbol.for('permdock.problem');

function trpcCode(
  status: number,
):
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'TOO_MANY_REQUESTS'
  | 'SERVICE_UNAVAILABLE'
  | 'FORBIDDEN' {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'FORBIDDEN';
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
  if (cause !== null && typeof cause === 'object') {
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
  if (
    result === null ||
    typeof result !== 'object' ||
    (result as { readonly ok?: unknown }).ok !== false
  ) {
    return Promise.resolve(result);
  }
  const error = (result as { readonly error?: unknown }).error;
  const cause =
    error instanceof TRPCError && error.code === 'INTERNAL_SERVER_ERROR'
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
  if (cause === null || typeof cause !== 'object' || !(PROBLEM in cause)) {
    return opts.shape;
  }
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
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const opts = optsByRequest.get(request);
        return opts === undefined ? null : options.subject(opts);
      },
      memberships: options.memberships,
      relations: options.relations,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: 'trpc',
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
    return requestFromCtx(ctx as object);
  };

  /**
   * One `Request` per HTTP request, shared by every procedure in a batch. The
   * subject reads the first procedure's opts; the tenant is resolved from each
   * procedure's own opts in `scopeOf`, never through the shared `Request`.
   */
  const bind = (opts: TrpcMiddlewareOpts<TCtx>): Request => {
    const ctx = opts.ctx as object;
    const hit = requestByCtx.get(ctx);
    if (hit !== undefined) {
      return hit;
    }
    const request =
      requestOf(opts.ctx) ??
      new Request(`http://localhost/trpc/${opts.path}`, { method: 'POST' });
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
    permission: Permission,
    loadData: (() => unknown) | undefined,
    protectOptions: StreamProtectOptions | undefined,
  ): Promise<unknown> => {
    if (
      result === null ||
      typeof result !== 'object' ||
      (result as { readonly ok?: unknown }).ok !== true ||
      !isAsyncIterable((result as { readonly data?: unknown }).data)
    ) {
      return result;
    }
    const conn = await connection(
      opts,
      compact({ permission, data: loadData }),
    );
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
    permission: Permission,
    loadData?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ): TrpcMiddleware =>
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
          loadData === undefined ? undefined : (): unknown => loadData(opts),
          protectOptions,
        );
      }
      return throwTrpcError(guard.response);
    }) as TrpcMiddleware;

  const permdockHandler = (request: Request): Promise<Response> => {
    const opts = {
      ctx: { req: request } as TCtx,
      path: 'permdock',
      type: 'unknown',
      next: (nextOpts?: { readonly ctx: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { ctx: { req: request } as TCtx }),
    } satisfies TrpcMiddlewareOpts<TCtx>;
    bind(opts);
    const { POST, GET } = kernel.handler(() => scopeOf(opts));
    return Promise.resolve(
      request.method === 'GET' ? GET(request) : POST(request),
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
