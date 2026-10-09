import { Elysia } from "elysia";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type { OpenApiHooks, ProtectOptions } from "../server/create.ts";

import { bindKernel, decorate, socketConnection } from "../server/bind.ts";
import { hasCredentials, parsedBody } from "../server/http.ts";
import { problemFromError } from "../server/map-error.ts";
import { POLICY_VIOLATION, onRevoked } from "../server/stream.ts";

export type ElysiaCtx = {
  readonly request: Request;
  readonly body?: unknown;
  readonly params?: Readonly<Record<string, string | undefined>>;
};

export type ElysiaPermDockOptions<TUser = unknown> = ServerAdapterOptions<
  ElysiaCtx,
  TUser
> & {
  /** Ends or revalidates open sockets. */
  readonly revocations?: RevocationFeed;
};

/** The `ws` Elysia passes to `.ws` handlers; `data` is the upgrade context. */
export type ElysiaSocket = {
  readonly data: ElysiaCtx;
  close(code?: number, reason?: string): unknown;
};

export type ElysiaContext<V extends PolicyVocabulary = PolicyVocabulary> =
  ElysiaCtx & {
    permdock: PermDock<V>;
    permdockData?: unknown;
  };

export type ElysiaProtect = (
  permission: Permission | null,
  loadData?: (ctx: ElysiaCtx) => unknown,
  protectOptions?: ProtectOptions,
) => (ctx: ElysiaCtx) => Promise<Response | undefined>;

/** The `permdock()` plugin: its global derive types `permdock` in every later handler. */
export type ElysiaPermDockPlugin<
  V extends PolicyVocabulary = PolicyVocabulary,
> = Elysia<
  "",
  /* oxlint-disable typescript/no-generated-empty-object-type -- Elysia's own empty singleton slots */
  {
    decorator: Record<never, never>;
    store: Record<never, never>;
    derive: { readonly permdock: PermDock<V> };
    resolve: Record<never, never>;
  }
  /* oxlint-enable typescript/no-generated-empty-object-type */
>;

export type ElysiaPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: () => ElysiaPermDockPlugin<V>;
  readonly protect: ElysiaProtect;
  /**
   * One connection per socket: the same promise for every handler
   * of that socket; closes it with `1008` when the connection aborts.
   */
  readonly connection: (
    ws: ElysiaSocket,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly permdockHandler: () => Elysia;
  readonly openapi: OpenApiHooks;
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ElysiaPermDockOptions<TUser>,
): ElysiaPermDock<V> {
  const seed = globalThis.crypto.randomUUID();
  const { kernel, bind, scopeOf, handlerScope } = bindKernel(
    policy,
    options,
    "elysia",
    toRequest,
  );

  // SAFETY: the chain returns an Elysia instance; its generics are narrowed to the global permdock derive.
  const permdock = (): ElysiaPermDockPlugin<V> =>
    new Elysia({ name: "permdock", seed })
      .derive({ as: "global" }, async (ctx) => {
        const instance = await kernel.permdock(bind(ctx), await scopeOf(ctx));
        decorate(ctx, instance);
        return { permdock: instance };
      })
      .onError({ as: "global" }, ({ error, request }) =>
        problemFromError(error, {
          credentials: hasCredentials(request),
        }),
      ) as unknown as ElysiaPermDockPlugin<V>;

  const protect: ElysiaProtect =
    (permission, loadData, protectOptions) => async (ctx) => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(ctx),
        protectOptions,
      )(bind(ctx), await scopeOf(ctx));
      if (!guard.ok) {
        return guard.response;
      }
      decorate(ctx, guard.permdock, guard.data);
      return undefined;
    };

  const sockets = new WeakMap<object, Promise<Connection>>();

  const connection = (
    ws: ElysiaSocket,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> =>
    socketConnection(sockets, ws.data, async () => {
      const conn = await kernel.connection(
        bind(ws.data),
        connectionOptions,
        await scopeOf(ws.data),
      );
      onRevoked(conn, (problem) => {
        ws.close(POLICY_VIOLATION, problem.type);
      });
      return conn;
    });

  const permdockHandler = (): Elysia => {
    const { POST, GET } = kernel.permdockHandler(handlerScope);
    // SAFETY: the chain returns an Elysia instance; only its accumulated generics are dropped.
    return new Elysia({ name: "permdock-handler", seed })
      .post("/", (ctx) => POST(bind(ctx)))
      .get("/", (ctx) => GET(bind(ctx))) as unknown as Elysia;
  };

  return {
    permdock,
    protect,
    connection,
    permdockHandler,
    openapi: kernel.openapi,
  };
}

function toRequest(ctx: ElysiaCtx): Request {
  const method = ctx.request.method;
  if (method === "GET" || method === "HEAD" || ctx.body === undefined) {
    return ctx.request;
  }
  const headers = new Headers(ctx.request.headers);
  const body = parsedBody(ctx.body, headers) ?? null;
  return new Request(ctx.request.url, { method, headers, body });
}
