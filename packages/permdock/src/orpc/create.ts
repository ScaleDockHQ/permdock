import { ORPCError, type Middleware } from '@orpc/server';

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

export type OrpcMiddlewareOpts<
  TCtx extends object = object,
  TInput = unknown,
> = {
  readonly context: TCtx;
  readonly input?: TInput;
  readonly path?: readonly string[];
  readonly next: (opts?: { readonly context: TCtx }) => Promise<unknown>;
};

export type OrpcMiddleware<
  TCtx extends object = object,
  TInput = unknown,
> = Middleware<
  TCtx,
  TCtx & {
    readonly permdock: PermDock;
    readonly permdockData?: unknown;
  },
  TInput,
  unknown,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- oRPC's own "no meta" type
  Record<never, never>
>;

export type OrpcPermDockOptions<
  TCtx extends object = object,
  TUser = unknown,
> = {
  readonly subject: (opts: OrpcMiddlewareOpts<TCtx>) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<OrpcMiddlewareOpts<TCtx>>;
  /** The Web `Request` behind a context; defaults to `context.request` or `context.req`. */
  readonly request?: (context: TCtx) => Request | null | undefined;
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
  /** Ends or revalidates open event iterators. */
  readonly revocations?: RevocationFeed;
};

export type OrpcOpenApiHooks<TCtx extends object = object> = {
  readonly protect: (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ) => OrpcMiddleware<TCtx>;
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly 'x-permdock-permissions': readonly string[];
  };
  readonly securitySchemes: OpenApiHooks['securitySchemes'];
};

export type OrpcPermDock<TCtx extends object = object> = {
  readonly permdock: () => OrpcMiddleware<TCtx>;
  readonly protect: (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ) => OrpcMiddleware<TCtx>;
  /** A long-lived connection for the request behind `context`. */
  readonly connection: (
    opts: OrpcMiddlewareOpts<TCtx>,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly permdockHandler: (request: Request) => Promise<Response>;
  readonly openapi: OrpcOpenApiHooks<TCtx>;
};

function hasBoundPermDock(context: unknown): boolean {
  return (
    context !== null &&
    typeof context === 'object' &&
    'permdock' in context &&
    (context as { readonly permdock?: unknown }).permdock !== undefined
  );
}

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

function toOpts<TCtx extends object>(
  mw: { readonly context: TCtx; readonly path?: readonly string[] },
  input: unknown,
  next: (opts?: { readonly context: TCtx }) => Promise<unknown>,
): OrpcMiddlewareOpts<TCtx> {
  return compact({
    context: mw.context,
    input,
    path: mw.path,
    next,
  });
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

function orpcCode(status: number): string {
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

function orpcErrorFrom(
  error: PermDockRevokedError,
): ORPCError<string, unknown> {
  const problem = error.toProblemDetails();
  return new ORPCError(orpcCode(problem.status), {
    message: error.code,
    data: problem,
  });
}

async function throwOrpcError(response: Response): Promise<never> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = { status: response.status };
  }
  const code = orpcCode(response.status);
  throw new ORPCError(code, {
    message: problemMessage(data, code),
    data,
  });
}

/** A PermDock error thrown further down (an `assert` in a handler) becomes the ORPCError `protect` throws. */
function mapDownstream<T>(run: () => T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  }).catch((error: unknown) => {
    const mapped = problemFromError(error);
    if (mapped === undefined) {
      throw error;
    }
    return throwOrpcError(mapped);
  });
}

export function createPermDock<
  TCtx extends object = object,
  TUser = unknown,
  TPrincipal extends Principal = Principal,
>(
  policy: Policy<TUser, TPrincipal>,
  options: OrpcPermDockOptions<TCtx, TUser>,
): OrpcPermDock<TCtx> {
  const optsByRequest = new WeakMap<Request, OrpcMiddlewareOpts<TCtx>>();
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
      adapter: 'orpc',
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
    return requestFromCtx(ctx);
  };

  /**
   * One `Request` per HTTP request, shared by every procedure in a batch. The
   * subject reads the first procedure's opts; the tenant is resolved from each
   * procedure's own opts in `scopeOf`, never through the shared `Request`.
   */
  const bind = (opts: OrpcMiddlewareOpts<TCtx>): Request => {
    const ctx = opts.context as object;
    const hit = requestByCtx.get(ctx);
    if (hit !== undefined) {
      return hit;
    }
    const path = opts.path?.join('.') ?? 'orpc';
    const request =
      requestOf(opts.context) ??
      new Request(`http://localhost/orpc/${path}`, { method: 'POST' });
    requestByCtx.set(ctx, request);
    if (!optsByRequest.has(request)) {
      optsByRequest.set(request, opts);
    }
    return request;
  };

  const scopeOf = (opts: OrpcMiddlewareOpts<TCtx>): Promise<TenantScope> =>
    tenantScope(options.tenant, opts);

  const attach = (ctx: object, request: Request): void => {
    requestByCtx.set(ctx, request);
  };

  const permdock = (): OrpcMiddleware<TCtx> =>
    ((mwOptions, input) => {
      const opts = toOpts(
        mwOptions as {
          readonly context: TCtx;
          readonly path?: readonly string[];
        },
        input,
        mwOptions.next as (nextOpts?: {
          readonly context: TCtx;
        }) => Promise<unknown>,
      );
      if (hasBoundPermDock(opts.context)) {
        return mwOptions.next({
          context: opts.context as TCtx & { readonly permdock: PermDock },
        });
      }
      const request = bind(opts);
      return scopeOf(opts)
        .then((scope) => kernel.permdock(request, scope))
        .then(
          (instance) => {
            const nextCtx = { ...opts.context, permdock: instance };
            attach(nextCtx, request);
            return mapDownstream(() => mwOptions.next({ context: nextCtx }));
          },
          (error: unknown) => {
            const response = invalidSignatureResponse(error);
            if (response !== undefined) {
              return throwOrpcError(response);
            }
            throw error;
          },
        );
    }) as OrpcMiddleware<TCtx>;

  const connection = async (
    opts: OrpcMiddlewareOpts<TCtx>,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> =>
    kernel.connection(bind(opts), connectionOptions, await scopeOf(opts));

  /** Wraps an event iterator so revocation ends it and unreadable items drop. */
  const guardOutput = async (
    result: unknown,
    opts: OrpcMiddlewareOpts<TCtx>,
    permission: Permission,
    loadData: (() => unknown) | undefined,
    protectOptions: StreamProtectOptions | undefined,
  ): Promise<unknown> => {
    const output =
      result !== null && typeof result === 'object' && 'output' in result
        ? (result as { readonly output: unknown }).output
        : undefined;
    if (!isAsyncIterable(output)) {
      return result;
    }
    const conn = await connection(
      opts,
      compact({ permission, data: loadData }),
    );
    return {
      ...(result as object),
      output: guardIterable(
        output,
        conn,
        compact({ items: protectOptions?.items, onRevoked: orpcErrorFrom }),
      ),
    };
  };

  const protect = (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ): OrpcMiddleware<TCtx> =>
    (async (mwOptions, input) => {
      const opts = toOpts(
        mwOptions as {
          readonly context: TCtx;
          readonly path?: readonly string[];
        },
        input,
        mwOptions.next as (nextOpts?: {
          readonly context: TCtx;
        }) => Promise<unknown>,
      );
      const request = bind(opts);
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(opts),
        protectOptions,
      )(request, await scopeOf(opts));
      if (guard.ok) {
        const nextCtx = {
          ...opts.context,
          permdock: guard.permdock,
          permdockData: guard.data,
        };
        attach(nextCtx, request);
        return guardOutput(
          await mapDownstream(() => mwOptions.next({ context: nextCtx })),
          opts,
          permission,
          loadData === undefined ? undefined : (): unknown => loadData(opts),
          protectOptions,
        );
      }
      return throwOrpcError(guard.response);
    }) as OrpcMiddleware<TCtx>;

  const permdockHandler = (request: Request): Promise<Response> => {
    const opts = {
      context: { req: request } as TCtx,
      path: ['permdock'],
      next: (nextOpts?: { readonly context: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { context: { req: request } as TCtx }),
    } satisfies OrpcMiddlewareOpts<TCtx>;
    bind(opts);
    const { POST, GET } = kernel.handler(() => scopeOf(opts));
    return Promise.resolve(
      request.method === 'GET' ? GET(request) : POST(request),
    );
  };

  const kernelOpenApi = kernel.openapi;
  const openapi: OrpcOpenApiHooks<TCtx> = {
    protect,
    security: kernelOpenApi.security,
    securitySchemes: kernelOpenApi.securitySchemes,
  };

  return { permdock, protect, connection, permdockHandler, openapi };
}
