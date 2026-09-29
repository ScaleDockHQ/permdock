import type { SSEMessage, SSEStreamingApi } from 'hono/streaming';
import type { WSEvents } from 'hono/ws';

import { Hono, type Context, type MiddlewareHandler, type Next } from 'hono';

import type { ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  LimitStore,
  EntitlementSource,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type { Connection, ConnectionOptions } from '../server/connection.ts';
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { PermDockRevokedError } from '../core/errors.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import { problemFromError } from '../server/map-error.ts';
import {
  POLICY_VIOLATION,
  guardIterable,
  onRevoked,
} from '../server/stream.ts';
import { invalidSignatureResponse } from '../server/web-bot-auth.ts';

export type HonoPermDockOptions<TUser = unknown> = {
  readonly subject: (c: Context) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<Context>;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
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
  /** Ends or revalidates open sockets and streams. */
  readonly revocations?: RevocationFeed;
};

/** The `Variables` both middlewares set; Hono merges them into the route's Env. */
export type PermDockEnv<TData = unknown> = {
  readonly Variables: {
    readonly permdock: PermDock;
    readonly permdockData: TData;
  };
};

export type HonoPermDock = {
  readonly permdock: () => MiddlewareHandler<PermDockEnv>;
  readonly protect: <TData = unknown>(
    permission: Permission,
    loadData?: (c: Context) => TData | Promise<TData>,
    protectOptions?: ProtectOptions,
  ) => MiddlewareHandler<PermDockEnv<NonNullable<TData>>>;
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
  readonly items?: Permission<string, unknown, 'instance'>;
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
        event: 'permdock',
        data: JSON.stringify(error.toProblemDetails()),
      });
    }
  } finally {
    Promise.resolve(iterator.return(undefined)).catch(() => undefined);
  }
}

function mapDownstream(c: Context): void {
  const mapped = c.error === undefined ? undefined : problemFromError(c.error);
  if (mapped !== undefined) {
    c.res = undefined;
    c.res = mapped;
  }
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: HonoPermDockOptions<TUser>,
): HonoPermDock {
  const contexts = new WeakMap<Request, Context>();
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const c = contexts.get(request);
        return c === undefined ? null : options.subject(c);
      },
      memberships: options.memberships,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: 'hono',
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const bind = (c: Context): Request => {
    const raw = c.req.raw;
    if (!contexts.has(raw)) {
      contexts.set(raw, c);
    }
    return raw;
  };

  const scopeOf = (c: Context): Promise<TenantScope> =>
    tenantScope(options.tenant, c);

  const permdock =
    (): MiddlewareHandler<PermDockEnv> => async (c, next: Next) => {
      try {
        c.set('permdock', await kernel.permdock(bind(c), await scopeOf(c)));
      } catch (error) {
        const response = invalidSignatureResponse(error);
        if (response !== undefined) {
          return response;
        }
        throw error;
      }
      await next();
      mapDownstream(c);
      return undefined;
    };

  const protect =
    <TData = unknown>(
      permission: Permission,
      loadData?: (c: Context) => TData | Promise<TData>,
      protectOptions?: ProtectOptions,
    ): MiddlewareHandler<PermDockEnv<NonNullable<TData>>> =>
    async (c, next: Next): Promise<Response | undefined> => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(c),
        protectOptions,
      )(bind(c), await scopeOf(c));
      if (!guard.ok) {
        return guard.response;
      }
      c.set('permdock', guard.permdock);
      c.set('permdockData', guard.data as NonNullable<TData>);
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
    const { POST, GET } = kernel.handler((request) => {
      const c = contexts.get(request);
      return c === undefined ? { tenant: undefined } : scopeOf(c);
    });
    const app = new Hono();
    app.post('/', (c) => POST(bind(c)));
    app.get('/', (c) => GET(bind(c)));
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
