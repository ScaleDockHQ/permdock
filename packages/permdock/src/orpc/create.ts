import type { Middleware } from "@orpc/server";

import { ORPCError } from "@orpc/server";

import type { PermDockRevokedError } from "../core/errors.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type { TenantScope } from "../server/create.ts";
import type { OpenApiHooks } from "../server/server-types.ts";
import type { StreamProtectOptions } from "../server/stream.ts";
import type { OperationsRouterOf } from "./operations.ts";

import {
  compact,
  isPermission,
  attached,
  problemMessage,
  problemFromError,
  bindRpcKernel,
  guardStream,
  problemBody,
  rpcCode,
  isAsyncIterable,
  reloadAfter,
} from "../server/kit.ts";
import { operationsRouterOf } from "./operations.ts";

export type OrpcMiddlewareOpts<
  TCtx extends object = object,
  TInput = unknown,
> = {
  readonly context: TCtx;
  readonly input?: TInput;
  readonly path?: readonly string[];
  readonly next: (opts?: { readonly context: TCtx }) => Promise<unknown>;
};

export type OrpcMiddleware<
  TCtx extends object = object,
  TInput = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> = Middleware<
  TCtx,
  TCtx & { readonly permdock: PermDock<V>; readonly permdockData?: unknown },
  TInput,
  // oxlint-disable-next-line typescript/no-explicit-any -- oRPC's middleware default; `unknown` rejects procedures with a declared output
  any,
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- oRPC's own "no meta" type
  Record<never, never>
>;

export type OrpcPermDockOptions<
  TCtx extends object = object,
  TUser = unknown,
> = ServerAdapterOptions<OrpcMiddlewareOpts<TCtx>, TUser> & {
  /**
   * The Web `Request` behind a context; defaults to `context.request` or
   * `context.req`.
   */
  readonly request?: (context: TCtx) => Request | null | undefined;
  /** Ends or revalidates open event iterators. */
  readonly revocations?: RevocationFeed;
};

export type OrpcOpenApiHooks<
  TCtx extends object = object,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly protect: (
    permission: Permission | null,
    data?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ) => OrpcMiddleware<TCtx, unknown, V>;
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly "x-permdock-permissions": readonly string[];
  };
  /**
   * `security` as the merge function oRPC 2's `openapi({ spec })` takes, with
   * mutable arrays so it type-checks against oRPC's `OperationObject`.
   */
  readonly spec: (
    permission: Permission,
  ) => <TSpec extends object>(current: TSpec) => TSpec & OrpcSecuritySpec;
  readonly securitySchemes: OpenApiHooks["securitySchemes"];
};

export type OrpcSecuritySpec = {
  security: Record<string, string[]>[];
  "x-permdock-permissions": string[];
};

export type OrpcPermDock<
  TCtx extends object = object,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  /**
   * The `PermDock` for one procedure call, for code the middleware does not run
   * before.
   */
  readonly getPermDock: (
    opts: OrpcMiddlewareOpts<TCtx>,
  ) => Promise<PermDock<V>>;
  readonly middleware: () => OrpcMiddleware<TCtx, unknown, V>;
  readonly protect: (
    permission: Permission | null,
    data?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ) => OrpcMiddleware<TCtx, unknown, V>;
  /** A long-lived connection for the request behind `context`. */
  readonly connection: (
    opts: OrpcMiddlewareOpts<TCtx>,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly permdockHandler: () => (request: Request) => Promise<Response>;
  readonly openapi: OrpcOpenApiHooks<TCtx, V>;
  /**
   * One procedure per `defineOperations` entry, guarded by the operation's
   * permission and `data` loader; `meta` attaches oRPC meta such as
   * `openapi()`.
   */
  readonly operationsRouter: OperationsRouterOf<TCtx, V>;
};

function toOpts<TCtx extends object>(
  mw: { readonly context: TCtx; readonly path?: readonly string[] },
  input: unknown,
  next: (opts?: { readonly context: TCtx }) => Promise<unknown>,
): OrpcMiddlewareOpts<TCtx> {
  return compact({ context: mw.context, input, path: mw.path, next });
}

/** The procedure's `errors` from its contract or `.errors()`, keyed by code. */
type ErrorConstructors = Readonly<Record<string, unknown>>;

function isErrorConstructor(
  value: unknown,
): value is (options: {
  readonly message: string;
  readonly data: unknown;
}) => Error {
  return typeof value === "function";
}

/**
 * Uses the procedure's own constructor when it declares the code, so the
 * declared status and `defined` apply.
 */
function orpcError(
  code: string,
  message: string,
  data: unknown,
  errors: ErrorConstructors | undefined,
): Error {
  const declared =
    errors !== undefined && Object.hasOwn(errors, code)
      ? errors[code]
      : undefined;
  return isErrorConstructor(declared)
    ? declared({ message, data })
    : new ORPCError(code, { message, data });
}

function orpcErrorFrom(
  error: PermDockRevokedError,
  errors?: ErrorConstructors,
): Error {
  const problem = error.toProblemDetails();
  return orpcError(rpcCode(problem.status), error.code, problem, errors);
}

async function throwOrpcError(
  response: Response,
  errors?: ErrorConstructors,
): Promise<never> {
  const data = await problemBody(response);
  const code = rpcCode(response.status);
  throw orpcError(code, problemMessage(data, code), data, errors);
}

/**
 * A PermDock error thrown further down (an `assert` in a handler) becomes the
 * ORPCError `protect` throws.
 */
function mapDownstream<T>(
  run: () => T | PromiseLike<T>,
  errors?: ErrorConstructors,
): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  }).catch((error: unknown) => {
    const mapped = problemFromError(error);
    if (mapped === undefined) {
      throw error;
    }
    return throwOrpcError(mapped, errors);
  });
}

/** Registered, so a second copy of `permdock` in the bundle reads the same tag. */
const PERMISSION = Symbol.for("permdock.orpc.permission");

function tagged<T extends object>(
  permission: Permission | null,
  middleware: T,
): T {
  if (permission !== null) {
    Object.defineProperty(middleware, PERMISSION, { value: permission });
  }
  return middleware;
}

function readOwn(value: unknown, key: PropertyKey): unknown {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * The permission the procedure's first `protect` decides, or `undefined` when
 * no `protect` is attached. Reads the procedure definition only and never
 * decides.
 */
export function permissionOf(procedure: unknown): Permission | undefined {
  const ordered = readOwn(readOwn(procedure, "~orpc"), "orderedMiddlewares");
  if (!Array.isArray(ordered)) {
    return undefined;
  }
  for (const entry of ordered) {
    const permission = readOwn(readOwn(entry, "middleware"), PERMISSION);
    if (isPermission(permission)) {
      return permission;
    }
  }
  return undefined;
}

export function createPermDock<
  TCtx extends object = object,
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: OrpcPermDockOptions<TCtx, TUser>,
): OrpcPermDock<TCtx, V> {
  const {
    kernel,
    bind,
    attach,
    scopeOf,
    connection,
    evaluate,
    guard: runGuard,
  } = bindRpcKernel(
    policy,
    options,
    "orpc",
    (opts: OrpcMiddlewareOpts<TCtx>) => opts.context,
    (opts) => opts.path?.join(".") ?? "orpc",
  );

  /** Instances this factory built, with the tenant each was built for. */
  const issued = new WeakMap<object, string | undefined>();
  const issue = <T extends object>(instance: T, scope: TenantScope): T => {
    issued.set(instance, scope.tenant);
    return instance;
  };
  const boundFor = (
    context: object,
    scope: TenantScope,
  ): PermDock<V> | undefined => {
    const bound: unknown = Reflect.get(context, "permdock");
    if (
      typeof bound !== "object" ||
      bound === null ||
      !issued.has(bound) ||
      issued.get(bound) !== scope.tenant
    ) {
      return undefined;
    }
    // SAFETY: issued only holds instances this factory built from its own policy.
    return bound as PermDock<V>;
  };

  const getPermDock = async (
    opts: OrpcMiddlewareOpts<TCtx>,
  ): Promise<PermDock<V>> => {
    const scope = await scopeOf(opts);
    return (
      boundFor(opts.context, scope) ??
      issue(await kernel.getPermDock(bind(opts), scope), scope)
    );
  };

  // SAFETY: the function has oRPC's middleware call shape; its generics cannot be inferred from it.
  const middleware = (): OrpcMiddleware<TCtx, unknown, V> =>
    ((mwOptions, input) => {
      // SAFETY: oRPC passes this middleware's context as TCtx and next takes the extended context.
      const opts = toOpts(
        mwOptions as {
          readonly context: TCtx;
          readonly path?: readonly string[];
        },
        input,
        mwOptions.next as (nextOpts?: {
          readonly context: TCtx;
        }) => Promise<unknown>,
      );
      const request = bind(opts);
      return scopeOf(opts)
        .then((scope) =>
          attached(
            async () =>
              boundFor(opts.context, scope) ??
              issue(await kernel.getPermDock(request, scope), scope),
          ),
        )
        .then((instance) => {
          if (!instance.ok) {
            return throwOrpcError(instance.response, mwOptions.errors);
          }
          const nextCtx = { ...opts.context, permdock: instance.permdock };
          attach(nextCtx, request);
          return mapDownstream(
            () => mwOptions.next({ context: nextCtx }),
            mwOptions.errors,
          );
        });
    }) as OrpcMiddleware<TCtx, unknown, V>;

  /** Wraps an event iterator so revocation ends it and unreadable items drop. */
  const guardOutput = async (
    result: unknown,
    opts: OrpcMiddlewareOpts<TCtx>,
    permission: Permission | null,
    data: (() => unknown) | undefined,
    protectOptions: StreamProtectOptions | undefined,
    errors: ErrorConstructors,
  ): Promise<unknown> => {
    const output =
      result !== null && typeof result === "object" && "output" in result
        ? result.output
        : undefined;
    if (!isAsyncIterable(output)) {
      return result;
    }
    // SAFETY: output was read from result above, so result is an object.
    return {
      ...(result as object),
      output: await guardStream(
        output,
        (connectionOptions) => connection(opts, connectionOptions),
        permission,
        data,
        protectOptions,
        {
          onRevoked: (error: PermDockRevokedError) =>
            orpcErrorFrom(error, errors),
        },
      ),
    };
  };

  const protect = (
    permission: Permission | null,
    data?: (opts: OrpcMiddlewareOpts<TCtx>) => unknown,
    protectOptions?: StreamProtectOptions,
  ): OrpcMiddleware<TCtx, unknown, V> =>
    tagged(
      permission,
      // SAFETY: the function has oRPC's middleware call shape; its generics cannot be inferred from it.
      (async (mwOptions, input) => {
        // SAFETY: oRPC passes this middleware's context as TCtx and next takes the extended context.
        const opts = toOpts(
          mwOptions as {
            readonly context: TCtx;
            readonly path?: readonly string[];
          },
          input,
          mwOptions.next as (nextOpts?: {
            readonly context: TCtx;
          }) => Promise<unknown>,
        );
        const { request, scope, guard } = await runGuard(
          permission,
          data,
          opts,
          protectOptions,
        );
        if (guard.ok) {
          const nextCtx = {
            ...opts.context,
            permdock: issue(guard.permdock, scope),
            permdockData: guard.data,
          };
          attach(nextCtx, request);
          return guardOutput(
            await mapDownstream(
              () => mwOptions.next({ context: nextCtx }),
              mwOptions.errors,
            ),
            opts,
            permission,
            data === undefined
              ? undefined
              : reloadAfter(guard.data, (): unknown => data(opts)),
            protectOptions,
            mwOptions.errors,
          );
        }
        return throwOrpcError(guard.response, mwOptions.errors);
      }) as OrpcMiddleware<TCtx, unknown, V>,
    );

  const handler = (request: Request): Promise<Response> => {
    // SAFETY: the handler route runs outside oRPC, so its only context is the request as req.
    const opts = {
      context: { req: request } as TCtx,
      path: ["permdock"],
      next: (nextOpts?: { readonly context: TCtx }): Promise<unknown> =>
        Promise.resolve(nextOpts ?? { context: { req: request } as TCtx }),
    } satisfies OrpcMiddlewareOpts<TCtx>;
    return evaluate(request, opts);
  };

  const kernelOpenApi = kernel.openapi;
  const openapi: OrpcOpenApiHooks<TCtx, V> = {
    protect,
    security: kernelOpenApi.security,
    spec: (permission) => {
      const fragment = kernelOpenApi.security(permission);
      return (current) => ({
        ...current,
        security: fragment.security.map((requirement) =>
          Object.fromEntries(
            Object.entries(requirement).map(([scheme, scopes]) => [
              scheme,
              [...scopes],
            ]),
          ),
        ),
        "x-permdock-permissions": [...fragment["x-permdock-permissions"]],
      });
    },
    securitySchemes: kernelOpenApi.securitySchemes,
  };

  return {
    getPermDock,
    middleware,
    protect,
    connection,
    permdockHandler: () => handler,
    openapi,
    operationsRouter: operationsRouterOf({ middleware, protect }),
  };
}
