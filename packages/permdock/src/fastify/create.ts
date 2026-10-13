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

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type { OpenApiHooks, ProtectOptions } from "../server/server-types.ts";

import {
  type ServerAdapterOptions,
  bindKernel,
  decorate,
} from "../server/bind.ts";
import { hasCredentials } from "../server/http.ts";
import { problemFromError } from "../server/map-error.ts";
import { sendReply, toRequest } from "./http.ts";

const SKIP_OVERRIDE = Symbol.for("skip-override");

export type FastifyPermDockOptions<TUser = unknown> = ServerAdapterOptions<
  FastifyRequest,
  TUser
>;

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
  readonly middleware: () => FastifyPluginAsync;
  readonly protect: FastifyProtect;
  readonly permdockHandler: () => FastifyPluginAsync;
  /** Types `request.permdock` for a route registered after `middleware()` or `protect`. */
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

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: FastifyPermDockOptions<TUser>,
): FastifyPermDock<V> {
  const {
    kernel,
    bind,
    rebind,
    scopeOf,
    handlerScope,
    guard: runGuard,
  } = bindKernel(policy, options, "fastify", toRequest);

  const plugin = breakEncapsulation((app) => {
    app.decorateRequest("permdock", null);
    app.decorateRequest("permdockData", null);
    app.addHook("onRequest", async (request) => {
      if (skipped(request)) {
        return;
      }
      decorate(
        request,
        await kernel.getPermDock(bind(request), await scopeOf(request)),
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
        credentials: hasCredentials(request),
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
      const guard = await runGuard(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(request),
        plain,
        protectOptions,
      );
      if (!guard.ok) {
        await sendReply(reply, guard.response);
        return;
      }
      decorate(plain, guard.permdock, guard.data);
    };

  const handler: FastifyPluginAsync = (app) => {
    const { POST, GET } = kernel.permdockHandler(handlerScope);
    app.post("/", async (request, reply) => {
      await sendReply(reply, await POST(rebind(request)));
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
      // SAFETY: the route runs after middleware() or protect, which set request.permdock from this factory's policy.
      fn(request as PermDockRequest<Route, V>, reply);

  return {
    middleware: () => plugin,
    protect,
    permdockHandler: () => handler,
    withPermDock,
    openapi: kernel.openapi,
  };
}
