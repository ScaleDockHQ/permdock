import { ORPCError, type AnyMiddleware } from '@orpc/server';

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

export type OrpcMiddlewareOpts<TCtx = object, TInput = unknown> = {
  readonly context: TCtx;
  readonly input?: TInput;
  readonly path?: readonly string[];
  readonly next: (opts?: { readonly context: TCtx }) => Promise<unknown>;
};

export type OrpcMiddleware = AnyMiddleware;

export type OrpcPermDockOptions<TCtx = object> = {
  readonly subject: (opts: OrpcMiddlewareOpts<TCtx>) => unknown;
  readonly tenant?:
    | string
    | ((
        opts: OrpcMiddlewareOpts<TCtx>,
      ) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly webBotAuth?: WebBotAuthOptions;
};

export type OrpcOpenApiHooks<TCtx = object> = {
  readonly protect: (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
  ) => OrpcMiddleware;
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly 'x-permdock-permissions': readonly string[];
  };
  readonly securitySchemes: OpenApiHooks['securitySchemes'];
};

export type OrpcPermDock<TCtx = object> = {
  readonly permdock: () => OrpcMiddleware;
  readonly protect: (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
  ) => OrpcMiddleware;
  readonly permdockHandler: (request: Request) => Promise<Response>;
  readonly openapi: OrpcOpenApiHooks<TCtx>;
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

function toOpts<TCtx>(
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

async function throwOrpcError(response: Response): Promise<never> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = { status: response.status };
  }
  const code =
    response.status === 401
      ? 'UNAUTHORIZED'
      : response.status === 400
        ? 'BAD_REQUEST'
        : 'FORBIDDEN';
  throw new ORPCError(code, {
    message: problemMessage(data, code),
    data,
  });
}

export function createPermDock<TCtx = object>(
  policy: Policy,
  options: OrpcPermDockOptions<TCtx>,
): OrpcPermDock<TCtx> {
  const optsByRequest = new WeakMap<Request, OrpcMiddlewareOpts<TCtx>>();
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

  const bind = (opts: OrpcMiddlewareOpts<TCtx>): Request => {
    const ctx = opts.context as object;
    const hit = requestByCtx.get(ctx);
    if (hit !== undefined) {
      optsByRequest.set(hit, opts);
      return hit;
    }
    const fromCtx = requestFromCtx(ctx);
    const path = opts.path?.join('.') ?? 'orpc';
    const request =
      fromCtx ??
      new Request(`http://localhost/orpc/${path}`, { method: 'POST' });
    requestByCtx.set(ctx, request);
    optsByRequest.set(request, opts);
    return request;
  };

  const attach = (ctx: object, request: Request): void => {
    requestByCtx.set(ctx, request);
  };

  const permdock = (): OrpcMiddleware =>
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
      const request = bind(opts);
      const ctx = opts.context as object;
      let built = instances.get(ctx);
      if (built === undefined) {
        built = kernel.permdock(request);
        instances.set(ctx, built);
      }
      return built.then(
        (instance) => {
          const nextCtx = { ...opts.context, permdock: instance };
          attach(nextCtx, request);
          return mwOptions.next({ context: nextCtx });
        },
        (error: unknown) => {
          const response = invalidSignatureResponse(error);
          if (response !== undefined) {
            return throwOrpcError(response);
          }
          throw error;
        },
      );
    }) as OrpcMiddleware;

  const protect = (
    permission: Permission,
    loadData?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
  ): OrpcMiddleware =>
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
      )(request);
      if (guard.ok) {
        const nextCtx = {
          ...opts.context,
          permdock: guard.permdock,
          permdockData: guard.data,
        };
        attach(nextCtx, request);
        return mwOptions.next({ context: nextCtx });
      }
      return throwOrpcError(guard.response);
    }) as OrpcMiddleware;

  const permdockHandler = (request: Request): Promise<Response> => {
    const opts = {
      context: { req: request } as TCtx,
      path: ['permdock'],
      next: (nextOpts?: { readonly context: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { context: { req: request } as TCtx }),
    } satisfies OrpcMiddlewareOpts<TCtx>;
    bind(opts);
    const { POST, GET } = kernel.handler();
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

  return { permdock, protect, permdockHandler, openapi };
}
