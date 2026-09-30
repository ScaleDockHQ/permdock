import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifySchema,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteGenericInterface,
} from 'fastify';

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
import { sendReply, toRequest } from './http.ts';

const SKIP_OVERRIDE = Symbol.for('skip-override');

export type FastifyPermDockOptions<TUser = unknown> = {
  readonly subject: (request: FastifyRequest) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<FastifyRequest>;
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

export type PermDockRequest<
  Route extends RouteGenericInterface = RouteGenericInterface,
> = FastifyRequest<Route> & {
  permdock: PermDock;
  permdockData?: unknown;
};

/** A request typed by the route, its schema and the app's type provider. */
export type ProtectRequest<
  Route extends RouteGenericInterface = RouteGenericInterface,
  Schema extends FastifySchema = FastifySchema,
  Provider extends FastifyTypeProvider = FastifyTypeProviderDefault,
> = FastifyRequest<
  Route,
  RawServerDefault,
  RawRequestDefaultExpression,
  Schema,
  Provider
>;

/**
 * Generic over the route, schema and type provider so a `preHandler` slot
 * infers them: `loadData` sees the same typed `request.body` as the handler.
 */
export type FastifyProtect = <
  Route extends RouteGenericInterface = RouteGenericInterface,
  Schema extends FastifySchema = FastifySchema,
  Provider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(
  permission: Permission,
  loadData?: (request: ProtectRequest<Route, Schema, Provider>) => unknown,
  protectOptions?: ProtectOptions,
) => (
  request: ProtectRequest<Route, Schema, Provider>,
  reply: FastifyReply,
) => Promise<void>;

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

function decorate(
  request: FastifyRequest,
  instance: PermDock,
  data?: unknown,
): void {
  // SAFETY: the next line assigns permdock, which makes the request a PermDockRequest.
  const scoped = request as PermDockRequest;
  scoped.permdock = instance;
  if (data !== undefined) {
    scoped.permdockData = data;
  }
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: FastifyPermDockOptions<TUser>,
): FastifyPermDock {
  const contexts = new WeakMap<Request, FastifyRequest>();
  const bound = new WeakMap<FastifyRequest, Request>();
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
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
      adapter: 'fastify',
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

  const scopeOf = (request: FastifyRequest): Promise<TenantScope> =>
    tenantScope(options.tenant, request);

  const permdock = breakEncapsulation((app) => {
    app.decorateRequest('permdock', null);
    app.decorateRequest('permdockData', null);
    app.addHook('onRequest', async (request) => {
      decorate(
        request,
        await kernel.permdock(bind(request), await scopeOf(request)),
      );
    });
    // A user error handler may be async; Fastify types it as `void`.
    const previous: (
      this: typeof app,
      error: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => unknown = app.errorHandler;
    app.setErrorHandler(async function permdockErrors(err, request, reply) {
      const problem = problemFromError(err);
      if (problem === undefined) {
        await previous.call(this, err, request, reply);
        return undefined;
      }
      await sendReply(reply, problem);
      return undefined;
    });
    return Promise.resolve();
  });

  const protect: FastifyProtect =
    (permission, loadData, protectOptions) => async (request, reply) => {
      // SAFETY: a route-typed FastifyRequest; bind and scopeOf read only the untyped base request.
      const plain = request as FastifyRequest;
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(request),
        protectOptions,
      )(bind(plain), await scopeOf(plain));
      if (!guard.ok) {
        await sendReply(reply, guard.response);
        return;
      }
      decorate(plain, guard.permdock, guard.data);
    };

  const permdockHandler: FastifyPluginAsync = (app) => {
    const { POST, GET } = kernel.handler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    app.post('/', async (request, reply) => {
      const parsed = toRequest(request);
      contexts.set(parsed, request);
      await sendReply(reply, await POST(parsed));
    });
    app.get('/', async (request, reply) => {
      await sendReply(reply, await GET(bind(request)));
    });
    return Promise.resolve();
  };

  return { permdock, protect, permdockHandler, openapi: kernel.openapi };
}
