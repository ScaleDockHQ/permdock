import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';

import express from 'express';

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
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { OpenApiHooks } from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import { problemResponse } from '../server/problem.ts';
import { InvalidSignatureError } from '../server/web-bot-auth.ts';
import { sendResponse, toRequest } from './http.ts';

export type ExpressPermDockOptions<TUser = unknown> = {
  readonly subject: (req: Request) => TUser | Promise<TUser>;
  readonly tenant?:
    | string
    | ((req: Request) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
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

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ExpressPermDockOptions<TUser>,
): ExpressPermDock {
  const contexts = new WeakMap<globalThis.Request, Request>();
  const bound = new WeakMap<Request, globalThis.Request>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: globalThis.Request,
            ): string | undefined | Promise<string | undefined> => {
              const req = contexts.get(request);
              return req === undefined ? undefined : tenantOption(req);
            }
          : tenantOption,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
      webBotAuth: options.webBotAuth,
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

  const permdock = (): RequestHandler => (req, _res, next) => {
    run(async () => {
      const instance = await kernel.permdock(bind(req));
      (req as PermDockRequest).permdock = instance;
      next();
    }, next);
  };

  const protect =
    (
      permission: Permission,
      loadData?: (req: Request) => unknown,
    ): RequestHandler =>
    (req, res, next) => {
      run(async () => {
        const guard = await kernel.protect(
          permission,
          loadData === undefined ? undefined : (): unknown => loadData(req),
        )(bind(req));
        if (!guard.ok) {
          await sendResponse(res, guard.response);
          return;
        }
        const scoped = req as PermDockRequest;
        scoped.permdock = guard.permdock;
        scoped.permdockData = guard.data;
        next();
      }, next);
    };

  const errorHandler = (): ErrorRequestHandler => (err, _req, res, next) => {
    if (err instanceof InvalidSignatureError) {
      run(async () => {
        await sendResponse(res, err.response);
      }, next);
      return;
    }
    if (err instanceof PermDockDeniedError) {
      run(async () => {
        await sendResponse(
          res,
          problemResponse(err.toProblemDetails(), undefined, err.decision),
        );
      }, next);
      return;
    }
    if (err instanceof PermDockApprovalRequiredError) {
      run(async () => {
        await sendResponse(
          res,
          problemResponse(err.toProblemDetails(), undefined, err.decision),
        );
      }, next);
      return;
    }
    if (err instanceof PermDockValidationError) {
      run(async () => {
        await sendResponse(res, problemResponse(err.toProblemDetails()));
      }, next);
      return;
    }
    next(err);
  };

  const permdockHandler = (): Router => {
    const { POST, GET } = kernel.handler();
    const router = express.Router();
    router.post('/', (req, res, next) => {
      run(async () => {
        await sendResponse(res, await POST(bind(req)));
      }, next);
    });
    router.get('/', (req, res, next) => {
      run(async () => {
        await sendResponse(res, await GET(bind(req)));
      }, next);
    });
    return router;
  };

  const handler =
    (fn: (req: PermDockRequest, res: Response) => unknown): RequestHandler =>
    (req, res, next) => {
      run(async () => {
        await fn(req as PermDockRequest, res);
      }, next);
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
