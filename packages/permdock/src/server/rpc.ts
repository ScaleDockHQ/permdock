import type { PermDockRevokedError } from "../core/errors.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "./bind.ts";
import type { Connection, ConnectionOptions } from "./connection.ts";
import type { ServerKernel, TenantScope } from "./create.ts";
import type { StreamProtectOptions } from "./stream.ts";

import { compact } from "../core/compact.ts";
import { adapterKernel } from "./bind.ts";
import { tenantScope } from "./create.ts";
import { requestFromContext } from "./http.ts";
import { guardIterable } from "./stream.ts";

export type RpcCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE"
  | "FORBIDDEN";

/** The tRPC and oRPC error code for a Problem Details status. */
export function rpcCode(status: number): RpcCode {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "FORBIDDEN";
  }
}

/**
 * The Problem Details body of a PermDock response, or `{ status }` when it has
 * none. An RPC error carries only this body; the response headers are dropped.
 */
export async function problemBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { status: response.status };
  }
}

export type RpcAdapterOptions<TOpts, TCtx, TUser> = ServerAdapterOptions<
  TOpts,
  TUser
> & {
  readonly request?: (ctx: TCtx) => Request | null | undefined;
  readonly revocations?: RevocationFeed;
};

export type RpcKernel<TOpts, V extends PolicyVocabulary> = {
  readonly kernel: ServerKernel<V>;
  /**
   * One `Request` per HTTP request, shared by every procedure in a batch. The
   * subject reads the first procedure's opts; the tenant is resolved from each
   * procedure's own opts in `scopeOf`, never through the shared `Request`.
   */
  readonly bind: (opts: TOpts) => Request;
  /** Maps the context a middleware passes on to the `Request` it was bound to. */
  readonly attach: (ctx: object, request: Request) => void;
  readonly scopeOf: (opts: TOpts) => Promise<TenantScope>;
  /** The connection for a subscription or event iterator, opened for `permission` and its row. */
  readonly connection: (
    opts: TOpts,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /** Answers the decision endpoint outside the router, with `opts` as the only context. */
  readonly evaluate: (request: Request, opts: TOpts) => Promise<Response>;
};

/**
 * The kernel of an RPC adapter. `contextOf` reads the procedure context from
 * its opts; `path` names the fallback `Request` for a context without one.
 */
export function bindRpcKernel<
  TOpts,
  TCtx,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: RpcAdapterOptions<TOpts, TCtx, TUser>,
  adapter: string,
  contextOf: (opts: TOpts) => TCtx,
  path: (opts: TOpts) => string,
): RpcKernel<TOpts, V> {
  const optsByRequest = new WeakMap<Request, TOpts>();
  const requestByCtx = new WeakMap<object, Request>();
  const kernel = adapterKernel(policy, options, adapter, (request) =>
    optsByRequest.get(request),
  );

  const requestOf = (ctx: TCtx): Request | undefined => {
    if (options.request !== undefined) {
      try {
        return options.request(ctx) ?? undefined;
      } catch {
        return undefined;
      }
    }
    // SAFETY: tRPC and oRPC always pass an object context; TCtx is unconstrained only for inference.
    return requestFromContext(ctx as object);
  };

  const bind = (opts: TOpts): Request => {
    const ctx = contextOf(opts);
    // SAFETY: tRPC and oRPC always pass an object context; TCtx is unconstrained only for inference.
    const key = ctx as object;
    const hit = requestByCtx.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const request =
      requestOf(ctx) ??
      new Request(`http://localhost/${adapter}/${path(opts)}`, {
        method: "POST",
      });
    requestByCtx.set(key, request);
    if (!optsByRequest.has(request)) {
      optsByRequest.set(request, opts);
    }
    return request;
  };

  const scopeOf = (opts: TOpts): Promise<TenantScope> =>
    tenantScope(options.tenant, opts);

  const connection = async (
    opts: TOpts,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> =>
    kernel.connection(bind(opts), connectionOptions, await scopeOf(opts));

  const evaluations = kernel.permdockHandler((request) => {
    const opts = optsByRequest.get(request);
    return opts === undefined ? { tenant: undefined } : scopeOf(opts);
  });

  const evaluate = (request: Request, opts: TOpts): Promise<Response> => {
    bind(opts);
    return request.method === "GET"
      ? evaluations.GET(request)
      : evaluations.POST(request);
  };

  return {
    kernel,
    bind,
    attach: (ctx, request) => {
      requestByCtx.set(ctx, request);
    },
    scopeOf,
    connection,
    evaluate,
  };
}

/** Wraps a streamed result so revocation ends it and items the subscriber cannot read drop. */
export async function guardStream(
  source: AsyncIterable<unknown>,
  open: (connectionOptions: ConnectionOptions) => Promise<Connection>,
  permission: Permission | null,
  loadData: (() => unknown) | undefined,
  protectOptions: StreamProtectOptions | undefined,
  guard: {
    readonly unwrap?: (item: unknown) => unknown;
    readonly onRevoked: (error: PermDockRevokedError) => unknown;
  },
): Promise<AsyncIterable<unknown>> {
  const conn = await open(
    permission === null ? {} : compact({ permission, data: loadData }),
  );
  return guardIterable(
    source,
    conn,
    compact({
      items: protectOptions?.items,
      unwrap: guard.unwrap,
      onRevoked: guard.onRevoked,
    }),
  );
}
