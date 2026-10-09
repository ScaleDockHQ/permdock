import type { SSEMessage, SSEStreamingApi } from "hono/streaming";
import type { WSEvents } from "hono/ws";

import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type { OpenApiHooks, ProtectOptions } from "../server/create.ts";

import { compact } from "../core/compact.ts";
import { PermDockRevokedError } from "../core/errors.ts";
import { bindKernel } from "../server/bind.ts";
import { problemFromError } from "../server/map-error.ts";
import {
  POLICY_VIOLATION,
  guardIterable,
  onRevoked,
} from "../server/stream.ts";

export type HonoPermDockOptions<TUser = unknown> = ServerAdapterOptions<
  Context,
  TUser
> & {
  /** Ends or revalidates open sockets and streams. */
  readonly revocations?: RevocationFeed;
};

/** The `Variables` both middlewares set; Hono merges them into the route's Env. */
export type PermDockEnv<
  TData = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly Variables: {
    readonly permdock: PermDock<V>;
    readonly permdockData: TData;
  };
};

export type HonoPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: () => MiddlewareHandler<PermDockEnv<unknown, V>>;
  readonly protect: <TData = unknown>(
    permission: Permission | null,
    loadData?: (c: Context) => TData | Promise<TData>,
    protectOptions?: ProtectOptions,
  ) => MiddlewareHandler<PermDockEnv<NonNullable<TData>, V>>;
  /** A long-lived connection for the request behind `c`. */
  readonly connection: (
    c: Context,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /** `upgradeWebSocket` events that close with `1008` when the connection aborts. */
  readonly socket: <T = unknown>(
    connection: Connection,
    events: WSEvents<T>,
  ) => WSEvents<T>;
  /**
   * Writes `source` to a `streamSSE` stream, dropping items the subscriber
   * cannot read, and resolves when it ends: after an `event: permdock` frame
   * when the connection aborts, when the client disconnects, or when the
   * source is done. Await it as the last statement of the callback.
   */
  readonly sse: <T>(
    connection: Connection,
    stream: SSEStreamingApi,
    source: AsyncIterable<T>,
    options?: SseOptions<T>,
  ) => Promise<void>;
  readonly permdockHandler: () => Hono;
  readonly openapi: OpenApiHooks;
};

function socket<T>(connection: Connection, events: WSEvents<T>): WSEvents<T> {
  return {
    ...events,
    onOpen: (evt, ws): void => {
      onRevoked(connection, (problem) => {
        ws.close(POLICY_VIOLATION, problem.type);
      });
      if (!connection.signal.aborted) {
        events.onOpen?.(evt, ws);
      }
    },
    onClose: (evt, ws): void => {
      connection.close();
      events.onClose?.(evt, ws);
    },
  };
}

export type SseOptions<T> = {
  /** Items the subscriber cannot read under this permission are dropped. */
  readonly items?: Permission<string, unknown, "instance">;
  /** The row to check for an item, when the item wraps it. */
  readonly unwrap?: (item: T) => unknown;
  /** The frame for an item; defaults to `{ data: JSON.stringify(item) }`. */
  readonly format?: (item: T) => SSEMessage;
};

async function sse<T>(
  connection: Connection,
  stream: SSEStreamingApi,
  source: AsyncIterable<T>,
  options: SseOptions<T> = {},
): Promise<void> {
  const disconnected = new Promise<IteratorReturnResult<undefined>>(
    (resolve) => {
      stream.onAbort(() => {
        connection.close();
        resolve({ done: true, value: undefined });
      });
    },
  );
  // SAFETY: guardIterable calls unwrap only with items from source, which are T.
  const iterator = guardIterable(
    source,
    connection,
    compact({
      items: options.items,
      unwrap: options.unwrap as ((item: unknown) => unknown) | undefined,
      onRevoked: (error: PermDockRevokedError): unknown => error,
    }),
  )[Symbol.asyncIterator]();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- items arrive one at a time
      const next = await Promise.race([iterator.next(), disconnected]);
      if (next.done === true || stream.aborted) {
        return;
      }
      // SAFETY: a value that is not done comes from source, an async iterable of T.
      const item = next.value as T;
      // oxlint-disable-next-line no-await-in-loop -- frames keep their order
      await stream.writeSSE(
        options.format?.(item) ?? { data: JSON.stringify(item) },
      );
    }
  } catch (error) {
    if (!(error instanceof PermDockRevokedError)) {
      throw error;
    }
    if (!stream.aborted) {
      await stream.writeSSE({
        event: "permdock",
        data: JSON.stringify(error.toProblemDetails()),
      });
    }
  } finally {
    Promise.resolve(iterator.return(undefined)).catch(() => undefined);
  }
}

function mapDownstream(c: Context): void {
  const mapped =
    c.error === undefined
      ? undefined
      : problemFromError(c.error, {
          credentials: c.req.header("authorization") !== undefined,
        });
  if (mapped !== undefined) {
    c.res = undefined;
    c.res = mapped;
  }
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: HonoPermDockOptions<TUser>,
): HonoPermDock<V> {
  const { kernel, bind, scopeOf, handlerScope, attach } = bindKernel(
    policy,
    options,
    "hono",
    (c: Context) => c.req.raw,
  );

  const permdock =
    (): MiddlewareHandler<PermDockEnv<unknown, V>> => async (c, next: Next) => {
      const attached = await attach(c);
      if (!attached.ok) {
        return attached.response;
      }
      c.set("permdock", attached.permdock);
      await next();
      mapDownstream(c);
      return undefined;
    };

  const protect =
    <TData = unknown>(
      permission: Permission | null,
      loadData?: (c: Context) => TData | Promise<TData>,
      protectOptions?: ProtectOptions,
    ): MiddlewareHandler<PermDockEnv<NonNullable<TData>, V>> =>
    async (c, next: Next): Promise<Response | undefined> => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(c),
        protectOptions,
      )(bind(c), await scopeOf(c));
      if (!guard.ok) {
        return guard.response;
      }
      c.set("permdock", guard.permdock);
      // SAFETY: guard.data is loadData's TData result; protect answers 404 when it is null or undefined.
      c.set("permdockData", guard.data as NonNullable<TData>);
      await next();
      mapDownstream(c);
      return undefined;
    };

  const connection = async (
    c: Context,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> =>
    kernel.connection(bind(c), connectionOptions, await scopeOf(c));

  const permdockHandler = (): Hono => {
    const { POST, GET } = kernel.permdockHandler(handlerScope);
    const app = new Hono();
    app.post("/", (c) => POST(bind(c)));
    app.get("/", (c) => GET(bind(c)));
    return app;
  };

  return {
    permdock,
    protect,
    connection,
    socket,
    sse,
    permdockHandler,
    openapi: kernel.openapi,
  };
}
