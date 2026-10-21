import type { APIEvent, FetchEvent } from "@solidjs/start/server";

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
  RouteEvent,
} from "../server/fetch-adapter.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  SnapshotQuery,
} from "../server/server-types.ts";

import { decorate, fetchAdapter, guardedRoute } from "../server/kit.ts";

/** The h3 event under every SolidStart request; `subject` and `scope` read it. */
export type SolidStartNativeEvent = FetchEvent["nativeEvent"];

/** An h3 middleware for `createMiddleware([...])` in `src/middleware.ts`. */
export type SolidStartMiddleware = (
  event: SolidStartNativeEvent,
  next: () => unknown,
) => Promise<unknown>;

export type SolidStartPermDockOptions<TUser = unknown> = FetchAdapterOptions<
  SolidStartNativeEvent,
  TUser
>;

/** What the adapter sets on `event.locals`. */
export type SolidStartPermDockLocals<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = { readonly permdock: PermDock<V>; readonly permdockData: TData };

/**
 * The event a wrapped API route receives: its own `APIEvent` with typed
 * `locals`.
 */
export type SolidStartPermDockEvent<
  TEvent extends FetchEvent = APIEvent,
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TEvent & { readonly locals: SolidStartPermDockLocals<TData, V> };

/** Wraps an API route handler. */
export type SolidStartGuarded<
  TData,
  V extends PolicyVocabulary = PolicyVocabulary,
> = <TEvent extends FetchEvent = APIEvent, R = Response>(
  handler: (event: SolidStartPermDockEvent<TEvent, TData, V>) => R | Promise<R>,
) => (event: TEvent) => Promise<R | Response>;

export type SolidStartProtect<V extends PolicyVocabulary = PolicyVocabulary> = {
  <T = unknown>(
    permission: Permission | null,
    data?: ContextReader<APIEvent, T | null | undefined>,
    protectOptions?: ProtectOptions,
  ): SolidStartGuarded<NonNullable<T>, V>;
  <TOperation extends Operation>(
    operation: TOperation,
    input?: ContextReader<APIEvent, OperationInput<TOperation>>,
    protectOptions?: ProtectOptions,
  ): SolidStartGuarded<unknown, V>;
};

/** The decision endpoint, one API route handler per method. */
export type SolidStartPermDockHandlers = {
  readonly GET: (event: FetchEvent) => Promise<Response>;
  readonly POST: (event: FetchEvent) => Promise<Response>;
};

export type SolidStartPermDock<V extends PolicyVocabulary = PolicyVocabulary> =
  {
    /**
     * Sets `event.context.permdock` on the h3 event; a bad Web Bot Auth
     * signature is a `401`.
     */
    readonly middleware: () => SolidStartMiddleware;
    /**
     * `export const DELETE = protect(permissions.post.delete,
     * loadPost)(handler)`.
     */
    readonly protect: SolidStartProtect<V>;
    /**
     * Types `event.locals.permdock` for an API route and answers a thrown
     * PermDock error with Problem Details.
     */
    readonly withPermDock: SolidStartGuarded<unknown, V>;
    /**
     * The instance for an API route, or a server function through
     * `getRequestEvent()`.
     */
    readonly getPermDock: (event: FetchEvent) => Promise<PermDock<V>>;
    /** The snapshot a route `query` returns for `permdock/solid`. */
    readonly getSnapshot: (
      event: FetchEvent,
      query?: SnapshotQuery,
    ) => Promise<Snapshot>;
    readonly connection: (
      event: FetchEvent,
      connectionOptions?: ConnectionOptions,
    ) => Promise<Connection>;
    /**
     * `export const { GET, POST } = permdockHandler()` in
     * `src/routes/api/permdock.ts`.
     */
    readonly permdockHandler: () => SolidStartPermDockHandlers;
    readonly openapi: OpenApiHooks;
  };

/**
 * `event.locals`. Its type, `App.RequestEventLocals`, is declared by
 * `@solidjs/start/env`, which only an app's own `tsconfig` loads.
 */
function localsOf(event: FetchEvent): object {
  // SAFETY: SolidStart creates `locals` as a plain object on every FetchEvent.
  return Reflect.get(event, "locals") as object;
}

const route: RouteEvent<FetchEvent, SolidStartNativeEvent> = {
  context: (event) => event.nativeEvent,
  locals: localsOf,
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: SolidStartPermDockOptions<TUser>,
): SolidStartPermDock<V> {
  const adapter = fetchAdapter(
    policy,
    options,
    "solid-start",
    (event: SolidStartNativeEvent) => event.req,
  );

  const middleware =
    (): SolidStartMiddleware =>
    async (event, next): Promise<unknown> => {
      const attached = await adapter.ensure(event.context, event);
      if (!attached.ok) {
        return attached.response;
      }
      return adapter.mapErrors(event, next);
    };

  // SAFETY: the overloads differ only in the types of `data` and the row; every guarded handler receives the event SolidStart passed, with locals set.
  const protect = ((
    target: ProtectTarget,
    data?: ContextReader<FetchEvent, unknown>,
    protectOptions?: ProtectOptions,
  ) =>
    guardedRoute(
      adapter,
      route,
      target,
      data,
      protectOptions,
    )) as unknown as SolidStartProtect<V>;

  const withPermDock =
    <R>(handler: (event: FetchEvent) => R | Promise<R>) =>
    async (event: FetchEvent): Promise<R | Response> => {
      const attached = await adapter.ensure(
        event.nativeEvent.context,
        event.nativeEvent,
      );
      if (!attached.ok) {
        return attached.response;
      }
      decorate(localsOf(event), attached.permdock);
      return adapter.mapErrors(event.nativeEvent, () => handler(event));
    };

  const handlers = (): SolidStartPermDockHandlers => {
    const { GET, POST } = adapter.handlers();
    return {
      GET: (event) => GET(event.nativeEvent),
      POST: (event) => POST(event.nativeEvent),
    };
  };

  return {
    middleware,
    protect,
    // SAFETY: the wrapper sets event.locals.permdock from this factory's policy before the handler runs.
    withPermDock: withPermDock as unknown as SolidStartGuarded<unknown, V>,
    getPermDock: (event) => adapter.getPermDock(event.nativeEvent),
    getSnapshot: (event, query) =>
      adapter.getSnapshot(event.nativeEvent, query),
    connection: (event, connectionOptions) =>
      adapter.connection(event.nativeEvent, connectionOptions),
    permdockHandler: handlers,
    openapi: adapter.kernel.openapi,
  };
}
