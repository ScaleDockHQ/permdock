import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";

import express from "express";

import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from "../server/create.ts";
import type { WebBotAuthVerifier } from "../server/web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createServerKernel, tenantScope } from "../server/create.ts";
import { problemFromError } from "../server/map-error.ts";
import { sendResponse, toRequest } from "./http.ts";

export type ExpressPermDockOptions<TUser = unknown> = InstanceOptions & {
  readonly subject: (req: Request) => TUser | Promise<TUser>;
  /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
  readonly actor?: (req: Request) => unknown;
  readonly tenant?: TenantOption<Request>;
  readonly store?: ApprovalStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** @deprecated Not read by any adapter. */
  readonly snapshots?: SnapshotSource;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
};

export type PermDockRequest<
  T = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = Request & {
  permdock: PermDock<V>;
  permdockData?: T;
};

export type ExpressPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: () => RequestHandler;
  readonly protect: (
    permission: Permission,
    loadData?: (req: Request) => unknown,
    protectOptions?: ProtectOptions,
  ) => RequestHandler;
  readonly errorHandler: () => ErrorRequestHandler;
  readonly permdockHandler: () => Router;
  readonly withPermDock: (
    fn: (req: PermDockRequest<unknown, V>, res: Response) => unknown,
  ) => RequestHandler;
  readonly openapi: OpenApiHooks;
};

function run(work: () => Promise<void>, next: (err?: unknown) => void): void {
  work().catch(next);
}

const errorHandler = (): ErrorRequestHandler => (err, req, res, next) => {
  const problem = problemFromError(err, {
    credentials: req.headers.authorization !== undefined,
  });
  if (problem === undefined) {
    next(err);
    return;
  }
  run(async () => {
    await sendResponse(res, problem);
  }, next);
};

const withPermDock =
  <V extends PolicyVocabulary>(
    fn: (req: PermDockRequest<unknown, V>, res: Response) => unknown,
  ): RequestHandler =>
  (req, res, next) => {
    run(async () => {
      // SAFETY: withPermDock wraps routes mounted after permdock() or protect(), which set req.permdock from this factory's policy.
      await fn(req as PermDockRequest<unknown, V>, res);
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

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ExpressPermDockOptions<TUser>,
): ExpressPermDock<V> {
  const contexts = new WeakMap<globalThis.Request, Request>();
  const bound = new WeakMap<Request, globalThis.Request>();
  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) =>
        withBound(contexts, request, options.subject, null),
      actor:
        options.actor === undefined
          ? undefined
          : (request: globalThis.Request): unknown =>
              withBound(
                contexts,
                request,
                (req): unknown => options.actor?.(req),
                undefined,
              ),
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      adapter: "express",
      wrap: options.otel,
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
    const { POST, GET } = kernel.permdockHandler((request) =>
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
    router.post("/", (req, res, next) => {
      run(async () => {
        await sendResponse(res, await POST(rebind(req)));
      }, next);
    });
    router.get("/", (req, res, next) => {
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
    withPermDock,
    openapi: kernel.openapi,
  };
}
