import { TRPCError, type AnyTRPCMiddlewareFunction } from '@trpc/server';

import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { OpenApiHooks } from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import { invalidSignatureResponse } from '../server/web-bot-auth.ts';

export type TrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly ctx: TCtx;
  readonly input?: TInput;
  readonly path: string;
  readonly type: string;
  readonly next: (opts?: { readonly ctx: TCtx }) => Promise<unknown>;
};

export type TrpcMiddleware = AnyTRPCMiddlewareFunction;

export type TrpcPermDockOptions<TCtx = object> = {
  readonly subject: (opts: TrpcMiddlewareOpts<TCtx>) => unknown;
  readonly tenant?:
    | string
    | ((
        opts: TrpcMiddlewareOpts<TCtx>,
      ) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly webBotAuth?: WebBotAuthOptions;
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
  ) => TrpcMiddleware;
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

async function throwTrpcError(response: Response): Promise<never> {
  let cause: unknown;
  try {
    cause = await response.json();
  } catch {
    cause = { status: response.status };
  }
  const code =
    response.status === 401
      ? 'UNAUTHORIZED'
      : response.status === 400
        ? 'BAD_REQUEST'
        : 'FORBIDDEN';
  throw new TRPCError({
    code,
    message: problemMessage(cause, code),
    cause,
  });
}

export function errorFormatter<TShape extends { readonly data: object }>(opts: {
  readonly shape: TShape;
  readonly error: { readonly cause?: unknown };
}): TShape {
  const cause = opts.error.cause;
  if (cause === null || typeof cause !== 'object') {
    return opts.shape;
  }
  return {
    ...opts.shape,
    data: { ...opts.shape.data, ...cause },
  };
}

export function createPermDock<TCtx = object>(
  policy: Policy,
  options: TrpcPermDockOptions<TCtx>,
): TrpcPermDock<TCtx> {
  const optsByRequest = new WeakMap<Request, TrpcMiddlewareOpts<TCtx>>();
  const requestByCtx = new WeakMap<object, Request>();
  const instances = new WeakMap<object, Promise<PermDock>>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const opts = optsByRequest.get(request);
        return opts === undefined ? null : options.subject(opts);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: Request,
            ): string | undefined | Promise<string | undefined> => {
              const opts = optsByRequest.get(request);
              return opts === undefined ? undefined : tenantOption(opts);
            }
          : tenantOption,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
      webBotAuth: options.webBotAuth,
    }),
  );

  const bind = (opts: TrpcMiddlewareOpts<TCtx>): Request => {
    const ctx = opts.ctx as object;
    const hit = requestByCtx.get(ctx);
    if (hit !== undefined) {
      optsByRequest.set(hit, opts);
      return hit;
    }
    const fromCtx = requestFromCtx(ctx);
    const request =
      fromCtx ??
      new Request(`http://localhost/trpc/${opts.path}`, { method: 'POST' });
    requestByCtx.set(ctx, request);
    optsByRequest.set(request, opts);
    return request;
  };

  const attach = (ctx: object, request: Request): void => {
    requestByCtx.set(ctx, request);
  };

  const permdock = (): TrpcMiddleware =>
    ((opts: TrpcMiddlewareOpts<TCtx>) => {
      const request = bind(opts);
      const ctx = opts.ctx as object;
      let built = instances.get(ctx);
      if (built === undefined) {
        built = kernel.permdock(request);
        instances.set(ctx, built);
      }
      return built.then(
        (instance) => {
          const nextCtx = { ...opts.ctx, permdock: instance };
          attach(nextCtx, request);
          return opts.next({ ctx: nextCtx });
        },
        (error: unknown) => {
          const response = invalidSignatureResponse(error);
          if (response !== undefined) {
            return throwTrpcError(response);
          }
          throw error;
        },
      );
    }) as TrpcMiddleware;

  const protect = (
    permission: Permission,
    loadData?: (opts: TrpcMiddlewareOpts<TCtx>) => unknown,
  ): TrpcMiddleware =>
    (async (opts: TrpcMiddlewareOpts<TCtx>): Promise<unknown> => {
      const request = bind(opts);
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(opts),
      )(request);
      if (guard.ok) {
        const nextCtx = {
          ...opts.ctx,
          permdock: guard.permdock,
          permdockData: guard.data,
        };
        attach(nextCtx, request);
        return opts.next({ ctx: nextCtx });
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
    const { POST, GET } = kernel.handler();
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

  return { permdock, protect, permdockHandler, openapi, errorFormatter };
}
