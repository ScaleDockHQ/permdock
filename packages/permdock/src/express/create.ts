import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';

import express from 'express';

import type { ApprovalStore } from '../approvals/types.ts';
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
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import { problemFromError } from '../server/map-error.ts';
import { sendResponse, toRequest } from './http.ts';

export type ExpressPermDockOptions<TUser = unknown> = {
  readonly subject: (req: Request) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<Request>;
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
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
};

export type PermDockRequest<T = unknown> = Request & {
  permdock: PermDock;
  permdockData?: T;
};

export type ExpressPermDock = {
  readonly permdock: () => RequestHandler;
  readonly protect: (
    permission: Permission,
    loadData?: (req: Request) => unknown,
    protectOptions?: ProtectOptions,
  ) => RequestHandler;
  readonly errorHandler: () => ErrorRequestHandler;
  readonly permdockHandler: () => Router;
  readonly handler: (
    fn: (req: PermDockRequest, res: Response) => unknown,
  ) => RequestHandler;
  readonly openapi: OpenApiHooks;
};

function run(work: () => Promise<void>, next: (err?: unknown) => void): void {
  work().catch(next);
}

const errorHandler = (): ErrorRequestHandler => (err, _req, res, next) => {
  const problem = problemFromError(err);
  if (problem === undefined) {
    next(err);
    return;
  }
  run(async () => {
    await sendResponse(res, problem);
  }, next);
};

const handler =
  (fn: (req: PermDockRequest, res: Response) => unknown): RequestHandler =>
  (req, res, next) => {
    run(async () => {
      // SAFETY: handler wraps routes mounted after permdock() or protect(), which set req.permdock.
      await fn(req as PermDockRequest, res);
    }, next);
  };

/** Runs `use` on the Express request bound to `request`; `fallback` for a request this adapter never bound. */
export function withBound<T>(
  contexts: WeakMap<globalThis.Request, Request>,
  request: globalThis.Request,
  use: (req: Request) => T,
  fallback: T,
): T {
  const req = contexts.get(request);
  return req === undefined ? fallback : use(req);
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ExpressPermDockOptions<TUser>,
): ExpressPermDock {
  const contexts = new WeakMap<globalThis.Request, Request>();
  const bound = new WeakMap<Request, globalThis.Request>();
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) =>
        withBound(contexts, request, options.subject, null),
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
      adapter: 'express',
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const bind = (req: Request): globalThis.Request => {
    const hit = bound.get(req);
    if (hit !== undefined) {
      return hit;
    }
    const request = toRequest(req);
    bound.set(req, request);
    contexts.set(request, req);
    return request;
  };

  const scopeOf = (req: Request): Promise<TenantScope> =>
    tenantScope(options.tenant, req);

  /** The decision endpoint reads the body a parser may have consumed since `bind`. */
  const rebind = (req: Request): globalThis.Request => {
    const request = toRequest(req);
    contexts.set(request, req);
    return request;
  };

  const permdock = (): RequestHandler => (req, _res, next) => {
    run(async () => {
      const instance = await kernel.permdock(bind(req), await scopeOf(req));
      // SAFETY: this assignment is what makes req a PermDockRequest.
      (req as PermDockRequest).permdock = instance;
      next();
    }, next);
  };

  const protect =
    (
      permission: Permission,
      loadData?: (req: Request) => unknown,
      protectOptions?: ProtectOptions,
    ): RequestHandler =>
    (req, res, next) => {
      run(async () => {
        const guard = await kernel.protect(
          permission,
          loadData === undefined ? undefined : (): unknown => loadData(req),
          protectOptions,
        )(bind(req), await scopeOf(req));
        if (!guard.ok) {
          await sendResponse(res, guard.response);
          return;
        }
        // SAFETY: the next line assigns permdock, which makes req a PermDockRequest.
        const scoped = req as PermDockRequest;
        scoped.permdock = guard.permdock;
        scoped.permdockData = guard.data;
        next();
      }, next);
    };

  const permdockHandler = (): Router => {
    const { POST, GET } = kernel.handler((request) =>
      withBound<TenantScope | Promise<TenantScope>>(
        contexts,
        request,
        scopeOf,
        {
          tenant: undefined,
        },
      ),
    );
    const router = express.Router({ mergeParams: true });
    router.post('/', (req, res, next) => {
      run(async () => {
        await sendResponse(res, await POST(rebind(req)));
      }, next);
    });
    router.get('/', (req, res, next) => {
      run(async () => {
        await sendResponse(res, await GET(bind(req)));
      }, next);
    });
    return router;
  };

  return {
    permdock,
    protect,
    errorHandler,
    permdockHandler,
    handler,
    openapi: kernel.openapi,
  };
}
