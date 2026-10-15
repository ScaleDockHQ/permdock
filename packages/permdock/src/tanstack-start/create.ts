import {
  type RequestMiddleware,
  type RequestMiddlewareAfterServer,
  createMiddleware,
} from "@tanstack/react-start";

import type { Operation, OperationInput } from "../core/operations.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Principal } from "../core/subject.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type {
  ContextReader,
  FetchAdapterOptions,
  ProtectTarget,
} from "../server/fetch-adapter.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  SnapshotQuery,
} from "../server/server-types.ts";

import { fetchAdapter } from "../server/kit.ts";

export type TanStackStartPermDockOptions<TUser = unknown> = FetchAdapterOptions<
  Request,
  TUser
>;

/** The server context `middleware()` adds for later middleware, server functions and server routes. */
export type TanStackStartPermDockContext<
  V extends PolicyVocabulary = PolicyVocabulary,
> = { readonly permdock: PermDock<V> };

/** The server context `protect` adds: the instance and the loaded row. */
export type TanStackStartGuardedContext<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TanStackStartPermDockContext<V> & { readonly permdockData: TData };

/** A request middleware for `createStart`'s `requestMiddleware`, a server route's `server.middleware` or a server function's `.middleware([...])`. */
export type TanStackStartMiddleware<TContext> = RequestMiddlewareAfterServer<
  StartRegister,
  undefined,
  TContext
>;

/** The register `createMiddleware` builds with; Start's middleware types are invariant in it. */
type StartRegister =
  ReturnType<typeof createMiddleware> extends RequestMiddleware<infer TRegister>
    ? TRegister
    : never;

export type TanStackStartProtect<
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  <T = unknown>(
    permission: Permission | null,
    data?: ContextReader<Request, T | null | undefined>,
    protectOptions?: ProtectOptions,
  ): TanStackStartMiddleware<TanStackStartGuardedContext<NonNullable<T>, V>>;
  <TOperation extends Operation>(
    operation: TOperation,
    input?: ContextReader<Request, OperationInput<TOperation>>,
    protectOptions?: ProtectOptions,
  ): TanStackStartMiddleware<TanStackStartGuardedContext<unknown, V>>;
};

/** A server route handler: `server: { handlers: { GET } }`. */
export type TanStackStartRouteHandler = (context: {
  readonly request: Request;
}) => Promise<Response>;

/** The decision endpoint, one server route handler per method. */
export type TanStackStartPermDockHandlers = {
  readonly GET: TanStackStartRouteHandler;
  readonly POST: TanStackStartRouteHandler;
};

export type TanStackStartPermDock<
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  /** Adds `context.permdock`; a bad Web Bot Auth signature is a `401`. */
  readonly middleware: () => TanStackStartMiddleware<
    TanStackStartPermDockContext<V>
  >;
  /** A refusal ends the request with Problem Details; a grant adds `context.permdock` and `context.permdockData`. */
  readonly protect: TanStackStartProtect<V>;
  /** The instance for a server function: `getPermDock(getRequest())`. */
  readonly getPermDock: (request: Request) => Promise<PermDock<V>>;
  /** The snapshot a route `loader` returns for `permdock/react`. */
  readonly getSnapshot: (
    request: Request,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly connection: (
    request: Request,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /** `server: { handlers: permdockHandler() }` on the `/api/permdock` route. */
  readonly permdockHandler: () => TanStackStartPermDockHandlers;
  readonly openapi: OpenApiHooks;
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: TanStackStartPermDockOptions<TUser>,
): TanStackStartPermDock<V> {
  const adapter = fetchAdapter(
    policy,
    options,
    "tanstack-start",
    (request: Request) => request,
  );

  const middleware = (): TanStackStartMiddleware<
    TanStackStartPermDockContext<V>
  > =>
    createMiddleware().server(async ({ request, next }) => {
      const attached = await adapter.attach(request);
      if (!attached.ok) {
        return attached.response;
      }
      const context: TanStackStartPermDockContext<V> = {
        permdock: attached.permdock,
      };
      return adapter.mapErrors(request, () => next({ context }));
    });

  // SAFETY: the overloads differ only in the types of `data` and the row; the middleware adds the row `guard` loaded.
  const protect = ((
    target: ProtectTarget,
    data?: ContextReader<Request, unknown>,
    protectOptions?: ProtectOptions,
  ) =>
    createMiddleware().server(async ({ request, next }) => {
      const guard = await adapter.guard(target, data, request, protectOptions);
      if (!guard.ok) {
        return guard.response;
      }
      const context: TanStackStartGuardedContext<unknown, V> = {
        permdock: guard.permdock,
        permdockData: guard.data,
      };
      return adapter.mapErrors(request, () => next({ context }));
    })) as unknown as TanStackStartProtect<V>;

  const handlers = (): TanStackStartPermDockHandlers => {
    const { GET, POST } = adapter.handlers();
    return {
      GET: ({ request }) => GET(request),
      POST: ({ request }) => POST(request),
    };
  };

  return {
    middleware,
    protect,
    getPermDock: adapter.getPermDock,
    getSnapshot: adapter.getSnapshot,
    connection: adapter.connection,
    permdockHandler: handlers,
    openapi: adapter.kernel.openapi,
  };
}
