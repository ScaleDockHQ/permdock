import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RouteGenericInterface,
} from 'fastify';

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
import type { OtelOptions } from '../otel/types.ts';
import type { OpenApiHooks } from '../server/create.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import { problemResponse } from '../server/problem.ts';
import { sendReply, toRequest } from './http.ts';

const SKIP_OVERRIDE = Symbol.for('skip-override');

export type FastifyPermDockOptions = {
  readonly subject: (request: FastifyRequest) => unknown;
  readonly tenant?:
    | string
    | ((
        request: FastifyRequest,
      ) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};

export type PermDockRequest<
  Route extends RouteGenericInterface = RouteGenericInterface,
> = FastifyRequest<Route> & {
  permdock: PermDock;
  permdockData?: unknown;
};

export type FastifyProtect = <
  Route extends RouteGenericInterface = RouteGenericInterface,
>(
  permission: Permission,
  loadData?: (request: FastifyRequest<Route>) => unknown,
) => (request: FastifyRequest<Route>, reply: FastifyReply) => Promise<void>;

export type FastifyPermDock = {
  readonly permdock: FastifyPluginAsync;
  readonly protect: FastifyProtect;
  readonly permdockHandler: FastifyPluginAsync;
  readonly openapi: OpenApiHooks;
};

function breakEncapsulation(plugin: FastifyPluginAsync): FastifyPluginAsync {
  Object.defineProperty(plugin, SKIP_OVERRIDE, { value: true });
  return plugin;
}

export function createPermDock(
  policy: Policy,
  options: FastifyPermDockOptions,
): FastifyPermDock {
  const contexts = new WeakMap<Request, FastifyRequest>();
  const bound = new WeakMap<FastifyRequest, Request>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: Request,
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
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const bind = (request: FastifyRequest): Request => {
    const hit = bound.get(request);
    if (hit !== undefined) {
      return hit;
    }
    const next = toRequest(request);
    bound.set(request, next);
    contexts.set(next, request);
    return next;
  };

  const decorate = (
    request: FastifyRequest,
    instance: PermDock,
    data?: unknown,
  ): void => {
    const scoped = request as PermDockRequest;
    scoped.permdock = instance;
    if (data !== undefined) {
      scoped.permdockData = data;
    }
  };

  const permdock = breakEncapsulation((app) => {
    app.decorateRequest('permdock', null);
    app.decorateRequest('permdockData', null);
    app.addHook('onRequest', async (request) => {
      decorate(request, await kernel.permdock(bind(request)));
    });
    app.setErrorHandler(async (err, _request, reply) => {
      if (err instanceof PermDockDeniedError) {
        await sendReply(
          reply,
          problemResponse(err.toProblemDetails(), undefined, err.decision),
        );
        return;
      }
      if (err instanceof PermDockApprovalRequiredError) {
        await sendReply(
          reply,
          problemResponse(err.toProblemDetails(), undefined, err.decision),
        );
        return;
      }
      if (err instanceof PermDockValidationError) {
        await sendReply(reply, problemResponse(err.toProblemDetails()));
        return;
      }
      await reply.send(err);
    });
    return Promise.resolve();
  });

  const protect: FastifyProtect =
    (permission, loadData) => async (request, reply) => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(request),
      )(bind(request));
      if (!guard.ok) {
        await sendReply(reply, guard.response);
        return;
      }
      decorate(request, guard.permdock, guard.data);
    };

  const permdockHandler: FastifyPluginAsync = (app) => {
    const { POST, GET } = kernel.handler();
    app.post('/', async (request, reply) => {
      await sendReply(reply, await POST(bind(request)));
    });
    app.get('/', async (request, reply) => {
      await sendReply(reply, await GET(bind(request)));
    });
    return Promise.resolve();
  };

  return { permdock, protect, permdockHandler, openapi: kernel.openapi };
}
