import type { Operation, OperationInput } from "../core/operations.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Principal } from "../core/subject.ts";
import type { Connection, ConnectionOptions } from "./connection.ts";
import type {
  ProtectOptions,
  ServerPermDock,
  SnapshotQuery,
} from "./server-types.ts";

import { compact } from "../core/compact.ts";
import { isPermission } from "../core/permission-registry.ts";
import {
  type AnyGuard,
  type Attached,
  type ServerAdapterOptions,
  bindKernel,
  decorate,
} from "./bind.ts";
import { hasCredentials } from "./http.ts";
import { problemFromError } from "./map-error.ts";
import { methodNotAllowed } from "./problem.ts";

/**
 * What `protect` checks: a permission, an operation from `defineOperations`, or
 * `null` for a route that needs only OAuth scopes.
 */
export type ProtectTarget = Permission | Operation | null;

/** Reads a value from the framework context; may be async. */
export type ContextReader<TContext, T> = (context: TContext) => T | Promise<T>;

/**
 * `protect`'s overloads: a permission takes the row loader, an operation the
 * reader of its input, which the operation's `data` turns into the row.
 */
export type FetchProtect<TContext, TResult> = {
  <T = unknown>(
    permission: Permission | null,
    data?: ContextReader<TContext, T | null | undefined>,
    protectOptions?: ProtectOptions,
  ): TResult;
  <TOperation extends Operation>(
    operation: TOperation,
    input?: ContextReader<TContext, OperationInput<TOperation>>,
    protectOptions?: ProtectOptions,
  ): TResult;
};

export type FetchAdapterOptions<
  TContext,
  TUser = unknown,
> = ServerAdapterOptions<TContext, TUser> & {
  /** Ends or revalidates open streams and sockets; never a decision input. */
  readonly revocations?: RevocationFeed;
};

/** The decision endpoint, one handler per method. */
export type PermDockHandlers<TContext> = {
  /** The snapshot for `permdock/react` and the other client entries. */
  readonly GET: (context: TContext) => Promise<Response>;
  /** AuthZEN-shaped evaluations. */
  readonly POST: (context: TContext) => Promise<Response>;
};

/** The members every meta-framework adapter shares, over its own context type. */
export type FetchAdapter<TContext, V extends PolicyVocabulary> = {
  readonly kernel: ServerPermDock<V>;
  /**
   * The instance for the request behind `context`; throws
   * `InvalidSignatureError` for a bad Web Bot Auth signature.
   */
  readonly getPermDock: (context: TContext) => Promise<PermDock<V>>;
  readonly getSnapshot: (
    context: TContext,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly attach: (context: TContext) => Promise<Attached<V>>;
  readonly guard: (
    target: ProtectTarget,
    data: ContextReader<TContext, unknown> | undefined,
    context: TContext,
    protectOptions?: ProtectOptions,
  ) => Promise<AnyGuard<V>>;
  /** The instance `target` already holds, or a new one set on it. */
  readonly ensure: (target: object, context: TContext) => Promise<Attached<V>>;
  readonly connection: (
    context: TContext,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  /**
   * Runs `work`, answering a thrown PermDock error with its Problem Details
   * response.
   */
  readonly mapErrors: <R>(
    context: TContext,
    work: () => R | Promise<R>,
  ) => Promise<R | Response>;
  readonly handlers: () => PermDockHandlers<TContext>;
  /**
   * The decision endpoint as one handler: `GET` and `HEAD`, `POST`, else `405`
   * with `Allow`.
   */
  readonly handler: () => (context: TContext) => Promise<Response>;
};

/**
 * Where a route handler finds the request: the adapter context and the object
 * the instance is set on.
 */
export type RouteEvent<TEvent, TContext> = {
  readonly context: (event: TEvent) => TContext;
  readonly locals: (event: TEvent) => object;
};

/**
 * `protect(target, data, options)(handler)` for a framework whose routes are
 * plain handlers: a refusal is the response, a grant sets `permdock` and
 * `permdockData` on the event's locals before `handler` runs.
 */
export function guardedRoute<TEvent, TContext, V extends PolicyVocabulary>(
  adapter: FetchAdapter<TContext, V>,
  route: RouteEvent<TEvent, TContext>,
  target: ProtectTarget,
  data: ContextReader<TEvent, unknown> | undefined,
  protectOptions: ProtectOptions | undefined,
): <R>(
  handler: (event: TEvent) => R | Promise<R>,
) => (event: TEvent) => Promise<R | Response> {
  return (handler) => async (event) => {
    const context = route.context(event);
    const guard = await adapter.guard(
      target,
      data === undefined ? undefined : (): unknown => data(event),
      context,
      protectOptions,
    );
    if (!guard.ok) {
      return guard.response;
    }
    decorate(route.locals(event), guard.permdock, guard.data);
    return adapter.mapErrors(context, () => handler(event));
  };
}

/**
 * `withPermDock(handler)`: the instance on the event's locals, built when no
 * middleware set it.
 */
export function instanceRoute<TEvent, TContext, V extends PolicyVocabulary>(
  adapter: FetchAdapter<TContext, V>,
  route: RouteEvent<TEvent, TContext>,
): <R>(
  handler: (event: TEvent) => R | Promise<R>,
) => (event: TEvent) => Promise<R | Response> {
  return (handler) => async (event) => {
    const context = route.context(event);
    const attached = await adapter.ensure(route.locals(event), context);
    if (!attached.ok) {
      return attached.response;
    }
    return adapter.mapErrors(context, () => handler(event));
  };
}

const ALLOW = "GET, HEAD, POST";

/**
 * The permission and row loader behind a `protect` target. For an operation,
 * `input` reads its input from the request and the operation's `data` loads the
 * row; an operation without `data` checks the permission with no row.
 */
export function protectTarget<TContext>(
  target: ProtectTarget,
  input: ContextReader<TContext, unknown> | undefined,
): {
  readonly permission: Permission | null;
  readonly data: ContextReader<TContext, unknown> | undefined;
} {
  if (target === null || isPermission(target)) {
    return { permission: target, data: input };
  }
  const load = target.data;
  return {
    permission: target.permission,
    data:
      load === undefined
        ? undefined
        : async (context: TContext): Promise<unknown> =>
            load(input === undefined ? undefined : await input(context)),
  };
}

function held<V extends PolicyVocabulary>(
  target: object,
): PermDock<V> | undefined {
  const value: unknown = Reflect.get(target, "permdock");
  // SAFETY: only `decorate` sets `permdock` on a framework target, with an instance of this factory's policy.
  return value === undefined || value === null
    ? undefined
    : (value as PermDock<V>);
}

/**
 * The kernel of an adapter whose framework hands its handlers a Fetch `Request`
 * inside its own context object (SvelteKit, Astro, h3, SolidStart, TanStack
 * Start).
 */
export function fetchAdapter<
  TContext extends object,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: FetchAdapterOptions<TContext, TUser>,
  adapter: string,
  requestOf: (context: TContext) => Request,
): FetchAdapter<TContext, V> {
  const { kernel, bind, scopeOf, handlerScope, attach, guard } = bindKernel(
    policy,
    options,
    adapter,
    requestOf,
  );

  const getPermDock = async (context: TContext): Promise<PermDock<V>> =>
    kernel.getPermDock(bind(context), await scopeOf(context));

  const getSnapshot = async (
    context: TContext,
    query: SnapshotQuery = {},
  ): Promise<Snapshot> => {
    const instance = await kernel.getPermDock(
      bind(context),
      query.tenant === undefined
        ? await scopeOf(context)
        : { tenant: query.tenant },
    );
    return instance.snapshot(
      compact({ include: query.include, tenants: query.tenants }),
    );
  };

  const ensure = async (
    target: object,
    context: TContext,
  ): Promise<Attached<V>> => {
    const existing = held<V>(target);
    if (existing !== undefined) {
      return { ok: true, permdock: existing };
    }
    const result = await attach(context);
    if (result.ok) {
      decorate(target, result.permdock);
    }
    return result;
  };

  const mapErrors = async <R>(
    context: TContext,
    work: () => R | Promise<R>,
  ): Promise<R | Response> => {
    try {
      return await work();
    } catch (error) {
      const problem = problemFromError(error, {
        credentials: hasCredentials(requestOf(context)),
      });
      if (problem === undefined) {
        throw error;
      }
      return problem;
    }
  };

  const handlers = (): PermDockHandlers<TContext> => {
    const { GET, POST } = kernel.permdockHandler(handlerScope);
    return {
      GET: (context) => GET(bind(context)),
      POST: (context) => POST(bind(context)),
    };
  };

  const handler = (): ((context: TContext) => Promise<Response>) => {
    const { GET, POST } = handlers();
    return (context) => {
      switch (requestOf(context).method) {
        case "GET":
        case "HEAD": {
          return GET(context);
        }
        case "POST": {
          return POST(context);
        }
        default: {
          return Promise.resolve(methodNotAllowed(ALLOW));
        }
      }
    };
  };

  return {
    kernel,
    getPermDock,
    getSnapshot,
    attach,
    guard: (target, data, context, protectOptions) => {
      const resolved = protectTarget(target, data);
      return guard(resolved.permission, resolved.data, context, protectOptions);
    },
    ensure,
    connection: async (context, connectionOptions) =>
      kernel.connection(
        bind(context),
        connectionOptions,
        await scopeOf(context),
      ),
    mapErrors,
    handlers,
    handler,
  };
}
