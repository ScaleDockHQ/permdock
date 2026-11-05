import type { RequestEvent } from "@sveltejs/kit";

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
  PermDockHandlers,
  ProtectTarget,
  RouteEvent,
} from "../server/fetch-adapter.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  SnapshotQuery,
} from "../server/server-types.ts";

import { fetchAdapter, guardedRoute, instanceRoute } from "../server/kit.ts";

/**
 * A `handle` hook. SvelteKit 2 exports `Handle` from `@sveltejs/kit` and
 * SvelteKit 3 from `@sveltejs/kit/hooks`; this shape is assignable to both.
 */
export type SvelteKitHandle = (input: {
  readonly event: RequestEvent;
  readonly resolve: (event: RequestEvent) => Promise<Response>;
}) => Promise<Response>;

export type SvelteKitPermDockOptions<TUser = unknown> = FetchAdapterOptions<
  RequestEvent,
  TUser
>;

/** What the adapter sets on `event.locals`. */
export type SvelteKitPermDockLocals<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = { readonly permdock: PermDock<V>; readonly permdockData: TData };

/**
 * The event a wrapped handler receives: the route's own event with typed
 * `locals`.
 */
export type SvelteKitPermDockEvent<
  TEvent extends RequestEvent = RequestEvent,
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TEvent & { readonly locals: SvelteKitPermDockLocals<TData, V> };

/**
 * Wraps a `+server.ts` handler; the route keeps its generated `RequestEvent`
 * type.
 */
export type SvelteKitGuarded<
  TData,
  V extends PolicyVocabulary = PolicyVocabulary,
> = <TEvent extends RequestEvent, R = Response>(
  handler: (event: SvelteKitPermDockEvent<TEvent, TData, V>) => R | Promise<R>,
) => (event: TEvent) => Promise<R | Response>;

export type SvelteKitProtect<V extends PolicyVocabulary = PolicyVocabulary> = {
  <T = unknown>(
    permission: Permission | null,
    data?: ContextReader<RequestEvent, T | null | undefined>,
    protectOptions?: ProtectOptions,
  ): SvelteKitGuarded<NonNullable<T>, V>;
  <TOperation extends Operation>(
    operation: TOperation,
    input?: ContextReader<RequestEvent, OperationInput<TOperation>>,
    protectOptions?: ProtectOptions,
  ): SvelteKitGuarded<unknown, V>;
};

export type SvelteKitPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /**
   * The `handle` hook: sets `event.locals.permdock`; a bad Web Bot Auth
   * signature is a `401`.
   */
  readonly middleware: () => SvelteKitHandle;
  /**
   * `export const DELETE = protect(permissions.post.delete,
   * loadPost)(handler)`.
   */
  readonly protect: SvelteKitProtect<V>;
  /**
   * Types `event.locals.permdock` for a handler and answers a thrown PermDock
   * error with Problem Details.
   */
  readonly withPermDock: SvelteKitGuarded<unknown, V>;
  /** The instance for a `load` function, an action or a handler. */
  readonly getPermDock: (event: RequestEvent) => Promise<PermDock<V>>;
  /** The snapshot a layout `load` returns for `permdock/svelte`. */
  readonly getSnapshot: (
    event: RequestEvent,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly connection: (
    event: RequestEvent,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /**
   * `export const { GET, POST } = permdockHandler()` in
   * `src/routes/api/permdock/+server.ts`.
   */
  readonly permdockHandler: () => PermDockHandlers<RequestEvent>;
  readonly openapi: OpenApiHooks;
};

const route: RouteEvent<RequestEvent, RequestEvent> = {
  context: (event) => event,
  locals: (event) => event.locals,
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: SvelteKitPermDockOptions<TUser>,
): SvelteKitPermDock<V> {
  const adapter = fetchAdapter(
    policy,
    options,
    "sveltekit",
    (event: RequestEvent) => event.request,
  );

  const middleware =
    (): SvelteKitHandle =>
    async ({ event, resolve }) => {
      const attached = await adapter.ensure(event.locals, event);
      return attached.ok ? resolve(event) : attached.response;
    };

  // SAFETY: the overloads differ only in the types of `data` and the row; every guarded handler receives the event SvelteKit passed, with locals set.
  const protect = ((
    target: ProtectTarget,
    data?: ContextReader<RequestEvent, unknown>,
    protectOptions?: ProtectOptions,
  ) =>
    guardedRoute(
      adapter,
      route,
      target,
      data,
      protectOptions,
    )) as unknown as SvelteKitProtect<V>;

  // SAFETY: instanceRoute sets event.locals.permdock from this factory's policy before the handler runs.
  const withPermDock = instanceRoute(
    adapter,
    route,
  ) as unknown as SvelteKitGuarded<unknown, V>;

  return {
    middleware,
    protect,
    withPermDock,
    getPermDock: adapter.getPermDock,
    getSnapshot: adapter.getSnapshot,
    connection: adapter.connection,
    permdockHandler: adapter.handlers,
    openapi: adapter.kernel.openapi,
  };
}
