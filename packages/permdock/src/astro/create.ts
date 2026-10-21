import type { APIContext, MiddlewareHandler } from "astro";

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

export type AstroPermDockOptions<TUser = unknown> = FetchAdapterOptions<
  APIContext,
  TUser
>;

/** What the adapter sets on `context.locals`. */
export type AstroPermDockLocals<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = { readonly permdock: PermDock<V>; readonly permdockData: TData };

/**
 * The context a wrapped endpoint receives: its own `APIContext` with typed
 * `locals`.
 */
export type AstroPermDockContext<
  TContext extends APIContext = APIContext,
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = TContext & { readonly locals: AstroPermDockLocals<TData, V> };

/** Wraps an endpoint; the route keeps its own `APIContext` type. */
export type AstroGuarded<
  TData,
  V extends PolicyVocabulary = PolicyVocabulary,
> = <TContext extends APIContext, R = Response>(
  handler: (
    context: AstroPermDockContext<TContext, TData, V>,
  ) => R | Promise<R>,
) => (context: TContext) => Promise<R | Response>;

export type AstroProtect<V extends PolicyVocabulary = PolicyVocabulary> = {
  <T = unknown>(
    permission: Permission | null,
    data?: ContextReader<APIContext, T | null | undefined>,
    protectOptions?: ProtectOptions,
  ): AstroGuarded<NonNullable<T>, V>;
  <TOperation extends Operation>(
    operation: TOperation,
    input?: ContextReader<APIContext, OperationInput<TOperation>>,
    protectOptions?: ProtectOptions,
  ): AstroGuarded<unknown, V>;
};

export type AstroPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /**
   * `onRequest` in `src/middleware.ts`: sets `context.locals.permdock`; a bad
   * Web Bot Auth signature is a `401`.
   */
  readonly middleware: () => MiddlewareHandler;
  /**
   * `export const DELETE = protect(permissions.post.delete,
   * loadPost)(handler)`.
   */
  readonly protect: AstroProtect<V>;
  /**
   * Types `context.locals.permdock` for an endpoint and answers a thrown
   * PermDock error with Problem Details.
   */
  readonly withPermDock: AstroGuarded<unknown, V>;
  /**
   * The instance for an endpoint, an action or a page's frontmatter (`Astro` is
   * an `APIContext`).
   */
  readonly getPermDock: (context: APIContext) => Promise<PermDock<V>>;
  /** The snapshot a page passes to a `permdock/react` island. */
  readonly getSnapshot: (
    context: APIContext,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly connection: (
    context: APIContext,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /**
   * `export const { GET, POST } = permdockHandler()` in
   * `src/pages/api/permdock.ts`.
   */
  readonly permdockHandler: () => PermDockHandlers<APIContext>;
  readonly openapi: OpenApiHooks;
};

const route: RouteEvent<APIContext, APIContext> = {
  context: (context) => context,
  locals: (context) => context.locals,
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: AstroPermDockOptions<TUser>,
): AstroPermDock<V> {
  const adapter = fetchAdapter(
    policy,
    options,
    "astro",
    (context: APIContext) => context.request,
  );

  const middleware = (): MiddlewareHandler => async (context, next) => {
    const attached = await adapter.ensure(context.locals, context);
    return attached.ok ? next() : attached.response;
  };

  // SAFETY: the overloads differ only in the types of `data` and the row; every guarded endpoint receives the context Astro passed, with locals set.
  const protect = ((
    target: ProtectTarget,
    data?: ContextReader<APIContext, unknown>,
    protectOptions?: ProtectOptions,
  ) =>
    guardedRoute(
      adapter,
      route,
      target,
      data,
      protectOptions,
    )) as unknown as AstroProtect<V>;

  // SAFETY: instanceRoute sets context.locals.permdock from this factory's policy before the endpoint runs.
  const withPermDock = instanceRoute(adapter, route) as unknown as AstroGuarded<
    unknown,
    V
  >;

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
