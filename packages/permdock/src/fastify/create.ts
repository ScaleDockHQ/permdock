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
} from "fastify";

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
import { sendReply, toRequest } from "./http.ts";

const SKIP_OVERRIDE = Symbol.for("skip-override");

export type FastifyPermDockOptions<TUser = unknown> = InstanceOptions & {
  readonly subject: (request: FastifyRequest) => TUser | Promise<TUser>;
  /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
  readonly actor?: (request: FastifyRequest) => unknown;
  readonly tenant?: TenantOption<FastifyRequest>;
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
  Route extends RouteGenericInterface = RouteGenericInterface,
  V extends PolicyVocabulary = PolicyVocabulary,
> = FastifyRequest<Route> & {
  permdock: PermDock<V>;
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
  permission: Permission | null,
  loadData?: (request: ProtectRequest<Route, Schema, Provider>) => unknown,
  protectOptions?: ProtectOptions,
) => (
  request: ProtectRequest<Route, Schema, Provider>,
  reply: FastifyReply,
) => Promise<void>;

export type FastifyPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: FastifyPluginAsync;
  readonly protect: FastifyProtect;
  readonly permdockHandler: FastifyPluginAsync;
  /** Types `request.permdock` for a route registered after `permdock` or `protect`. */
  readonly withPermDock: <
    Route extends RouteGenericInterface = RouteGenericInterface,
  >(
    fn: (request: PermDockRequest<Route, V>, reply: FastifyReply) => unknown,
  ) => (request: FastifyRequest<Route>, reply: FastifyReply) => unknown;
  readonly openapi: OpenApiHooks;
};

function breakEncapsulation(plugin: FastifyPluginAsync): FastifyPluginAsync {
  Object.defineProperty(plugin, SKIP_OVERRIDE, { value: true });
  return plugin;
}

/** A route registered with `config: { permdock: false }`, such as a health check, gets no instance. */
function skipped(request: FastifyRequest): boolean {
  const config: unknown = request.routeOptions.config;
  return (
    typeof config === "object" &&
    config !== null &&
    Reflect.get(config, "permdock") === false
  );
}

function decorate<V extends PolicyVocabulary>(
  request: FastifyRequest,
  instance: PermDock<V>,
  data?: unknown,
): void {
  // SAFETY: the next line assigns permdock, which makes the request a PermDockRequest.
  const scoped = request as PermDockRequest<RouteGenericInterface, V>;
  scoped.permdock = instance;
  if (data !== undefined) {
    scoped.permdockData = data;
  }
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: FastifyPermDockOptions<TUser>,
): FastifyPermDock<V> {
  const contexts = new WeakMap<Request, FastifyRequest>();
  const bound = new WeakMap<FastifyRequest, Request>();
  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      actor:
        options.actor === undefined
          ? undefined
          : (request: Request): unknown => {
              const req = contexts.get(request);
              return req === undefined ? undefined : options.actor?.(req);
            },
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      adapter: "fastify",
      wrap: options.otel,
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
    app.decorateRequest("permdock", null);
    app.decorateRequest("permdockData", null);
    app.addHook("onRequest", async (request) => {
      if (skipped(request)) {
        return;
      }
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
      const problem = problemFromError(err, {
        credentials: request.headers.authorization !== undefined,
      });
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
    const { POST, GET } = kernel.permdockHandler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    app.post("/", async (request, reply) => {
      const parsed = toRequest(request);
      contexts.set(parsed, request);
      await sendReply(reply, await POST(parsed));
    });
    app.get("/", async (request, reply) => {
      await sendReply(reply, await GET(bind(request)));
    });
    return Promise.resolve();
  };

  const withPermDock =
    <Route extends RouteGenericInterface>(
      fn: (request: PermDockRequest<Route, V>, reply: FastifyReply) => unknown,
    ) =>
    (request: FastifyRequest<Route>, reply: FastifyReply): unknown =>
      // SAFETY: the route runs after permdock or protect, which set request.permdock from this factory's policy.
      fn(request as PermDockRequest<Route, V>, reply);

  return {
    permdock,
    protect,
    permdockHandler,
    withPermDock,
    openapi: kernel.openapi,
  };
}
