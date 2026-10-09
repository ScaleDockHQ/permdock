import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";

import express from "express";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { OpenApiHooks, ProtectOptions } from "../server/create.ts";

import { bindKernel, decorate } from "../server/bind.ts";
import { problemFromError } from "../server/map-error.ts";
import { sendResponse, toRequest } from "./http.ts";

export type ExpressPermDockOptions<TUser = unknown> = ServerAdapterOptions<
  Request,
  TUser
>;

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
    permission: Permission | null,
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

function sendProblem(
  err: unknown,
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
): void {
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
}

/** Answers a PermDock error with Problem Details; anything else reaches the app's error middleware. */
function respond(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
  work: () => Promise<void>,
): void {
  work().catch((err: unknown) => {
    sendProblem(err, req, res, next);
  });
}

const errorHandler = (): ErrorRequestHandler => (err, req, res, next) => {
  sendProblem(err, req, res, next);
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

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ExpressPermDockOptions<TUser>,
): ExpressPermDock<V> {
  const { kernel, bind, rebind, scopeOf, handlerScope } = bindKernel(
    policy,
    options,
    "express",
    toRequest,
  );

  const permdock = (): RequestHandler => (req, res, next) => {
    respond(req, res, next, async () => {
      decorate(req, await kernel.permdock(bind(req), await scopeOf(req)));
      next();
    });
  };

  const protect =
    (
      permission: Permission | null,
      loadData?: (req: Request) => unknown,
      protectOptions?: ProtectOptions,
    ): RequestHandler =>
    (req, res, next) => {
      respond(req, res, next, async () => {
        const guard = await kernel.protect(
          permission,
          loadData === undefined ? undefined : (): unknown => loadData(req),
          protectOptions,
        )(bind(req), await scopeOf(req));
        if (!guard.ok) {
          await sendResponse(res, guard.response);
          return;
        }
        decorate(req, guard.permdock, guard.data);
        next();
      });
    };

  const permdockHandler = (): Router => {
    const { POST, GET } = kernel.permdockHandler(handlerScope);
    const router = express.Router({ mergeParams: true });
    router.post("/", (req, res, next) => {
      respond(req, res, next, async () => {
        await sendResponse(res, await POST(rebind(req)));
      });
    });
    router.get("/", (req, res, next) => {
      respond(req, res, next, async () => {
        await sendResponse(res, await GET(bind(req)));
      });
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
