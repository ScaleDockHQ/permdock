import type { EventHandler, H3Event, H3EventContext, Middleware } from "h3";

import type { PermDock } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Principal } from "../core/subject.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  SnapshotQuery,
} from "../server/server-types.ts";

import { decorate } from "../server/bind.ts";
import {
  type ContextReader,
  type FetchAdapterOptions,
  type FetchProtect,
  type ProtectTarget,
  fetchAdapter,
} from "../server/fetch-adapter.ts";

export type H3PermDockOptions<TUser = unknown> = FetchAdapterOptions<
  H3Event,
  TUser
>;

/** `event.context` once `middleware()` or `protect` ran: the instance and the loaded row. */
export type H3PermDockContext<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = H3EventContext & {
  readonly permdock: PermDock<V>;
  readonly permdockData: TData;
};

/** The event `withPermDock` hands its handler. */
export type H3PermDockEvent<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = H3Event & { readonly context: H3PermDockContext<TData, V> };

export type H3PermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  /** Global or route middleware that sets `event.context.permdock`. */
  readonly middleware: () => Middleware;
  /** Route middleware: a refusal short-circuits with Problem Details. */
  readonly protect: FetchProtect<H3Event, Middleware>;
  readonly getPermDock: (event: H3Event) => Promise<PermDock<V>>;
  readonly getSnapshot: (
    event: H3Event,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  /**
   * Types `event.context.permdock` and `permdockData` for the handler, builds
   * the instance when no middleware set it, and answers a thrown PermDock
   * error with Problem Details.
   */
  readonly withPermDock: <TData = unknown>(
    handler: (event: H3PermDockEvent<TData, V>) => unknown,
  ) => EventHandler;
  readonly connection: (
    event: H3Event,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /** The decision endpoint: `app.all('/api/permdock', permdockHandler())`. */
  readonly permdockHandler: () => EventHandler;
  readonly openapi: OpenApiHooks;
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: H3PermDockOptions<TUser>,
): H3PermDock<V> {
  const adapter = fetchAdapter(policy, options, "h3", (event) => event.req);

  const middleware =
    (): Middleware =>
    async (event, next): Promise<unknown> => {
      const attached = await adapter.ensure(event.context, event);
      if (!attached.ok) {
        return attached.response;
      }
      return adapter.mapErrors(event, next);
    };

  // SAFETY: both overloads build the same middleware; they differ only in the types of `data`.
  const protect = ((
    target: ProtectTarget,
    data?: ContextReader<H3Event, unknown>,
    protectOptions?: ProtectOptions,
  ): Middleware =>
    async (event, next): Promise<unknown> => {
      const guard = await adapter.guard(target, data, event, protectOptions);
      if (!guard.ok) {
        return guard.response;
      }
      decorate(event.context, guard.permdock, guard.data);
      return adapter.mapErrors(event, next);
    }) as FetchProtect<H3Event, Middleware>;

  const withPermDock =
    <TData = unknown>(
      handler: (event: H3PermDockEvent<TData, V>) => unknown,
    ): EventHandler =>
    async (event): Promise<unknown> => {
      const attached = await adapter.ensure(event.context, event);
      if (!attached.ok) {
        return attached.response;
      }
      // SAFETY: ensure set event.context.permdock from this factory's policy; permdockData is the loader's row when protect ran.
      return adapter.mapErrors(event, () =>
        handler(event as H3PermDockEvent<TData, V>),
      );
    };

  return {
    middleware,
    protect,
    getPermDock: adapter.getPermDock,
    getSnapshot: adapter.getSnapshot,
    withPermDock,
    connection: adapter.connection,
    permdockHandler: () => adapter.handler(),
    openapi: adapter.kernel.openapi,
  };
}
