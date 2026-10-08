import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { ApprovalHint } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Snapshot, SnapshotSource } from "../core/interfaces.ts";
import type {
  DecideOptions,
  PermDock,
  SnapshotOptions,
} from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Actor, Principal, Subject } from "../core/subject.ts";
import type { PdpFactory, PdpPermDock } from "../pdp/types.ts";
import type { Connection, ConnectionOptions } from "./connection.ts";
import type { WebBotAuthVerifier } from "./web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { challengeScope } from "../core/oauth-scopes.ts";
import { createPermDock as createCorePermDock } from "../core/permdock.ts";
import { listPermissions } from "../core/permissions.ts";
import { problemDetails } from "../core/problem-details.ts";
import { isActor } from "../core/subject.ts";
import {
  applyApprovalResume,
  createEvaluationsHandler,
} from "./evaluations.ts";
import {
  decisionResponse,
  notFoundProblem,
  problemFromDecision,
  unauthenticatedProblem,
} from "./problem.ts";
import { InvalidSignatureError } from "./web-bot-auth.ts";

export type ServerPermDockOptions<TUser = unknown> = InstanceOptions & {
  /** The user, or a full `Subject` (core then skips `policy.subject`); `null` is anonymous. */
  readonly subject: (
    request: Request,
  ) => TUser | Subject | null | Promise<TUser | Subject | null>;
  readonly actor?: (request: Request) => unknown;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
  readonly tenant?:
    | string
    | ((request: Request) => string | undefined | Promise<string | undefined>);
  readonly store?: ApprovalStore;
  /** Ends or revalidates open connections; never a decision input. */
  readonly revocations?: RevocationFeed;
  /**
   * `createPermDock` from `permdock/pdp`: `protect` then decides delegated
   * permissions through the remote PDP. The instance handlers receive stays
   * synchronous and keeps denying delegated permissions (`pdp-unavailable`).
   */
  readonly pdp?: PdpFactory;
  /** @deprecated Not read by any adapter. */
  readonly snapshots?: SnapshotSource;
  /** Added as `approval` to every `approval-required` problem. */
  readonly approval?: ApprovalHint;
  readonly operations?: OperationScopes;
};

export type OperationScopes = {
  oauthScopesForRequest(
    method: string,
    path: string,
  ): readonly string[] | undefined;
};

export type Guard<T = unknown, V extends PolicyVocabulary = PolicyVocabulary> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly decision: Extract<Decision, { readonly outcome: "granted" }>;
      readonly data: T;
    }
  | { readonly ok: false; readonly response: Response };

/**
 * What `protect(null, …)` resolves to: the route declares OAuth scopes and no
 * permission, so there is no decision to return.
 */
export type ScopeGuard<
  T = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly decision?: undefined;
      readonly data: T;
    }
  | { readonly ok: false; readonly response: Response };

type Loader<T> = (
  request: Request,
) => T | null | undefined | Promise<T | null | undefined>;

/**
 * `protect(permission, loadData?, options?)`, or `protect(null, loadData?,
 * { oauthScopes })` for a route that needs a signed-in principal and, from a
 * delegated token, one of the OAuth scopes it declares, but no permission.
 */
export type Protect<
  V extends PolicyVocabulary = PolicyVocabulary,
  TArgs extends unknown[] = [],
> = {
  <T = unknown>(
    permission: Permission,
    loadData?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (request: Request, ...args: TArgs) => Promise<Guard<T, V>>;
  <T = unknown>(
    permission: null,
    loadData?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (request: Request, ...args: TArgs) => Promise<ScopeGuard<T, V>>;
  <T = unknown>(
    permission: Permission | null,
    loadData?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (
    request: Request,
    ...args: TArgs
  ) => Promise<Guard<T, V> | ScopeGuard<T, V>>;
};

export type OpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly "x-permdock-permissions": readonly string[];
  };
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
};

export type ProtectOptions = {
  /**
   * `true` when `loadData` returns a row the server loaded itself, to skip
   * schema validation. Anything else is validated against the resource
   * schema before the check.
   */
  readonly trusted?: boolean;
  /**
   * The OAuth scopes that reach the route: a delegated token holding none of
   * them is refused with `insufficient_scope`. Default the `operations` entry
   * for the request. Required, here or there, for `protect(null)`.
   */
  readonly oauthScopes?: readonly string[];
};

/**
 * The active tenant an adapter resolved from its own framework context.
 * Present means "use this tenant", even when `tenant` is `undefined`.
 */
export type TenantScope = { readonly tenant: string | undefined };

export type TenantOption<TContext> =
  | string
  | ((context: TContext) => string | undefined | Promise<string | undefined>);

/** Resolves an adapter `tenant` option against its framework context; a throw is no tenant. */
export async function tenantScope<TContext>(
  option: TenantOption<TContext> | undefined,
  context: TContext,
): Promise<TenantScope> {
  if (option === undefined || typeof option === "string") {
    return { tenant: option };
  }
  try {
    return { tenant: await option(context) };
  } catch {
    return { tenant: undefined };
  }
}

export type ServerKernelOptions<
  TUser,
  V extends PolicyVocabulary = PolicyVocabulary,
> = ServerPermDockOptions<TUser> & {
  /** Wraps each instance the kernel builds, as `withOtel` does. */
  readonly wrap?: (permdock: PermDock<V>) => PermDock<V>;
  /** The `adapter` label on decision events, revocations and approvals. Defaults to `server`. */
  readonly adapter?: string;
};

/**
 * What an HTTP adapter builds on: `ServerPermDock` plus an explicit
 * `TenantScope` on every call, so the adapter resolves the tenant from its
 * own framework context.
 */
export type SnapshotQuery = {
  /** The active tenant; defaults to the `tenant` option resolved from the request. */
  readonly tenant?: string;
  readonly include?: SnapshotOptions["include"];
  readonly tenants?: "all";
};

export type ServerKernel<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: (
    request: Request,
    scope?: TenantScope,
  ) => Promise<PermDock<V>>;
  /**
   * The JSON snapshot for a loader (React Router, TanStack Start, SvelteKit, Nuxt), built from the
   * request's cached subject. Send it with `snapshotHeaders(snapshot)`.
   */
  readonly getSnapshot: (
    request: Request,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly protect: Protect<V, [scope?: TenantScope]>;
  /**
   * `protect` against an instance the adapter already holds, such as a gateway
   * connection's: the same OAuth scope check, loader, decision and approval resume.
   */
  readonly protectOn: <T = unknown>(
    instance: PermDock<V>,
    permission: Permission | null,
    load?: () => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
    request?: Request,
  ) => Promise<Guard<T, V> | ScopeGuard<T, V>>;
  readonly connection: <T = unknown>(
    request: Request,
    options?: ConnectionOptions<T>,
    scope?: TenantScope,
  ) => Promise<Connection>;
  readonly problem: ServerPermDock<V>["problem"];
  readonly openapi: OpenApiHooks;
  readonly permdockHandler: (
    scope?: (request: Request) => TenantScope | Promise<TenantScope>,
  ) => ReturnType<typeof createEvaluationsHandler>;
};

export type ServerPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: (request: Request) => Promise<PermDock<V>>;
  readonly getSnapshot: ServerKernel<V>["getSnapshot"];
  readonly protect: Protect<V>;
  /** A long-lived connection for a stream or socket opened by `request`. */
  readonly connection: <T = unknown>(
    request: Request,
    options?: ConnectionOptions<T>,
  ) => Promise<Connection>;
  readonly problem: (
    decision: Decision,
    init?: { readonly permission?: Permission; readonly instance?: string },
  ) => Response;
  readonly openapi: OpenApiHooks;
  readonly permdockHandler: () => ReturnType<typeof createEvaluationsHandler>;
};

async function resolveActor(
  request: Request,
  options: ServerPermDockOptions,
): Promise<Actor | undefined> {
  const verified =
    options.webBotAuth === undefined
      ? undefined
      : await options.webBotAuth(request);
  if (verified !== undefined) {
    return verified;
  }
  if (options.actor === undefined) {
    return undefined;
  }
  try {
    const resolved = await options.actor(request);
    return isActor(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

type Built<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: PermDock<V>;
  readonly remote: PdpPermDock | undefined;
};

type Resolved<TUser> = {
  readonly user: TUser | Subject | null;
  readonly actor: Actor | undefined;
};

const NO_TENANT = "\u0000";

function routeScopes(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scopes: unknown[] = Array.isArray(value) ? value : [];
  const names = scopes.filter(
    (scope): scope is string => typeof scope === "string" && scope !== "",
  );
  if (names.length === 0 || names.length !== scopes.length) {
    throw new TypeError(
      "PermDock: oauthScopes must be a non-empty list of scope names",
    );
  }
  return names;
}

const NOT_DELEGATED: Extract<Decision, { readonly outcome: "denied" }> = {
  outcome: "denied",
  denials: [{ role: null, reason: "not-delegated" }],
  alternatives: [],
};

/** The `403` `insufficient_scope` for a token that holds none of a route's OAuth scopes. */
function scopeProblem(
  permission: Permission | null,
  subject: Subject,
  credentials: boolean,
  scope: string | undefined,
): Response {
  return permission === null
    ? decisionResponse(
        problemDetails(
          compact({
            decision: NOT_DELEGATED,
            detail: `the token holds none of the OAuth scopes this route needs, such as ${String(scope)}`,
            scope,
          }),
        ),
        NOT_DELEGATED,
        compact({ credentials, scope }),
      )
    : problemFromDecision(
        NOT_DELEGATED,
        permission,
        subject,
        compact({ credentials, scope }),
      );
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ServerPermDockOptions<TUser>,
): ServerPermDock<V> {
  return createServerKernel(policy, options);
}

function problemFor(
  decision: Decision,
  init?: { readonly permission?: Permission; readonly instance?: string },
  approval?: ApprovalHint,
): Response {
  if (init?.permission !== undefined) {
    return problemFromDecision(
      decision,
      init.permission,
      undefined,
      compact({ instance: init.instance, approval }),
    );
  }
  if (decision.outcome === "granted") {
    return new Response(null, { status: 204 });
  }
  return decisionResponse(
    problemDetails(
      compact({ decision, detail: decision.outcome, instance: init?.instance }),
    ),
    decision,
  );
}

/**
 * The kernel behind every HTTP adapter. The subject and actor are resolved
 * once per `Request`; one instance is cached per `(Request, tenant)`, so a
 * global middleware and a later tenant-scoped `protect` never share a tenant.
 */
export function createServerKernel<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ServerKernelOptions<TUser, V>,
): ServerKernel<V> {
  const adapter = options.adapter ?? "server";
  const subjects = new WeakMap<Request, Promise<Resolved<TUser>>>();
  const instances = new WeakMap<Request, Map<string, Promise<Built<V>>>>();

  const resolveSubject = (request: Request): Promise<Resolved<TUser>> => {
    const hit = subjects.get(request);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = (async (): Promise<Resolved<TUser>> => {
      const actor = await resolveActor(request, options);
      let user: TUser | Subject | null = null;
      try {
        user = await options.subject(request);
      } catch {
        user = null;
      }
      return { user, actor };
    })();
    subjects.set(request, resolved);
    return resolved;
  };

  const freshSubject = async (request: Request): Promise<Resolved<TUser>> => {
    const actor = await resolveActor(request, options);
    try {
      return { user: await options.subject(request), actor };
    } catch {
      return { user: null, actor };
    }
  };

  const instanceFor = async (
    { user, actor }: Resolved<TUser>,
    tenant: string | undefined,
  ): Promise<Built<V>> => {
    const coreOptions = compact({
      tenant,
      ...instanceOptions(options),
      actor,
    });
    const permdock = await createCorePermDock(policy, user, coreOptions);
    const remote =
      options.pdp === undefined
        ? undefined
        : await options.pdp(policy, user, coreOptions);
    return {
      permdock: options.wrap === undefined ? permdock : options.wrap(permdock),
      remote,
    };
  };

  const build = async (
    request: Request,
    scope?: TenantScope,
  ): Promise<Built<V>> => {
    const { tenant } = scope ?? (await tenantScope(options.tenant, request));
    let byTenant = instances.get(request);
    if (byTenant === undefined) {
      byTenant = new Map();
      instances.set(request, byTenant);
    }
    const key = tenant ?? NO_TENANT;
    const hit = byTenant.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const built = (async (): Promise<Built<V>> =>
      instanceFor(await resolveSubject(request), tenant))();
    byTenant.set(key, built);
    return built;
  };

  const connection = async <T = unknown>(
    request: Request,
    connectionOptions: ConnectionOptions<T> = {},
    scope?: TenantScope,
  ): Promise<Connection> => {
    const { tenant } = scope ?? (await tenantScope(options.tenant, request));
    // Lazy: only apps that open connections bundle the revalidation loop.
    const { openConnection } = await import("./connection.ts");
    return openConnection<T>({
      open: async (): Promise<PermDock<V>> =>
        (await build(request, { tenant })).permdock,
      rebuild: async (): Promise<PermDock<V>> =>
        (await instanceFor(await freshSubject(request), tenant)).permdock,
      tenant,
      ...(options.revocations === undefined
        ? {}
        : { feed: options.revocations }),
      adapter,
      options: connectionOptions,
    });
  };

  const permdock = async (
    request: Request,
    scope?: TenantScope,
  ): Promise<PermDock<V>> => (await build(request, scope)).permdock;

  const getSnapshot = async (
    request: Request,
    query: SnapshotQuery = {},
  ): Promise<Snapshot> => {
    const instance = await permdock(
      request,
      query.tenant === undefined ? undefined : { tenant: query.tenant },
    );
    return instance.snapshot(
      compact({ include: query.include, tenants: query.tenants }),
    );
  };

  const protectRoute = <T = unknown>(
    permission: Permission | null,
    loadData?: Loader<T>,
    protectOptions: ProtectOptions = {},
  ): ((
    request: Request,
    scope?: TenantScope,
  ) => Promise<Guard<T, V> | ScopeGuard<T, V>>) => {
    if (
      permission === null &&
      routeScopes(protectOptions.oauthScopes) === undefined &&
      options.operations === undefined
    ) {
      throw new TypeError(
        "PermDock: protect(null) needs oauthScopes, in its options or an operations entry",
      );
    }
    return async (request, scope) => {
      let instance: PermDock<V>;
      let remote: PdpPermDock | undefined;
      try {
        ({ permdock: instance, remote } = await build(request, scope));
      } catch (error) {
        if (error instanceof InvalidSignatureError) {
          return { ok: false, response: error.response };
        }
        throw error;
      }
      return guardOn<T>(
        instance,
        remote,
        request,
        permission,
        loadData === undefined
          ? undefined
          : (): ReturnType<Loader<T>> => loadData(request),
        protectOptions,
      );
    };
  };

  const guardOn = async <T>(
    instance: PermDock<V>,
    remote: PdpPermDock | undefined,
    request: Request | undefined,
    permission: Permission | null,
    load: (() => ReturnType<Loader<T>>) | undefined,
    protectOptions: ProtectOptions,
  ): Promise<Guard<T, V> | ScopeGuard<T, V>> => {
    const declared = routeScopes(
      protectOptions.oauthScopes ??
        (request === undefined
          ? undefined
          : options.operations?.oauthScopesForRequest(
              request.method,
              new URL(request.url).pathname,
            )),
    );
    const credentials = request?.headers.has("authorization") ?? false;
    if (permission === null) {
      if (declared === undefined) {
        throw new TypeError(
          request === undefined
            ? "PermDock: protect(null) needs oauthScopes"
            : `PermDock: protect(null) needs oauthScopes, and no operation declares them for ${request.method} ${new URL(request.url).pathname}`,
        );
      }
      if (instance.subject.principal === null) {
        return { ok: false, response: unauthenticatedProblem(credentials) };
      }
    }
    const held = instance.subject.delegation?.scopes;
    if (
      declared !== undefined &&
      held !== undefined &&
      !declared.some((granted) => held.includes(granted))
    ) {
      return {
        ok: false,
        response: scopeProblem(
          permission,
          instance.subject,
          credentials,
          declared[0],
        ),
      };
    }
    let data: T | undefined;
    if (load !== undefined) {
      const loaded = await load();
      if (loaded === null || loaded === undefined) {
        return { ok: false, response: notFoundProblem() };
      }
      data = loaded;
    }
    if (permission === null) {
      // SAFETY: T is loadData's result type; data is undefined only when no loadData was passed.
      return { ok: true, permdock: instance, data: data as T };
    }
    const decideOptions = compact<DecideOptions>({
      source: "adapter",
      adapter,
      ...(protectOptions.trusted === true
        ? { trusted: true }
        : { trusted: false, boundary: "http-body" as const }),
    });
    // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
    const raw =
      remote === undefined
        ? (
            instance.decide as (
              next: Permission,
              row?: unknown,
              options?: DecideOptions,
            ) => Decision
          )(permission, data, decideOptions)
        : await remote
            .decide(permission, data, decideOptions)
            .catch((): Decision => ({
              outcome: "denied",
              denials: [{ role: null, reason: "pdp-unavailable" }],
              alternatives: [],
            }));
    const decision = await applyApprovalResume(
      raw,
      permission,
      instance,
      options.store,
      request,
      compact({
        type: permission.resource,
        id:
          data !== null &&
          typeof data === "object" &&
          "id" in data &&
          (typeof data.id === "string" || typeof data.id === "number")
            ? String(data.id)
            : undefined,
      }),
      adapter,
    );
    if (decision.outcome === "granted") {
      // SAFETY: T is loadData's result type; data is undefined only when no loadData was passed.
      return {
        ok: true,
        permdock: instance,
        decision,
        data: data as T,
      };
    }
    return {
      ok: false,
      response: problemFromDecision(
        decision,
        permission,
        instance.subject,
        compact({
          approval: options.approval,
          credentials,
          scope: declared?.[0] ?? challengeScope(policy, permission),
          disclosure:
            data === undefined
              ? undefined
              : policy.resources.get(permission.resource)?.disclosure,
        }),
      ),
    };
  };

  // SAFETY: Protect's overloads only narrow the guard by whether permission is null, which protectRoute branches on.
  const protect = protectRoute as Protect<V, [scope?: TenantScope]>;

  const openapi: OpenApiHooks = {
    security: (permission: Permission) => ({
      security: [{ oauth2: [permission.scope] }],
      "x-permdock-permissions": [permission.key],
    }),
    securitySchemes: () => {
      const scopes: Record<string, string> = {};
      for (const leaf of listPermissions(policy.permissions)) {
        scopes[leaf.scope] = leaf.meta.title ?? leaf.key;
      }
      return {
        oauth2: {
          type: "oauth2",
          flows: {},
          scopes,
        },
      };
    },
  };

  const permdockHandler = (
    scope?: (request: Request) => TenantScope | Promise<TenantScope>,
  ): ReturnType<typeof createEvaluationsHandler> =>
    createEvaluationsHandler(
      compact({
        policy,
        resolve:
          scope === undefined
            ? permdock
            : async (request: Request): Promise<PermDock<V>> =>
                permdock(request, await scope(request)),
        store: options.store,
        adapter,
      }),
    );

  return {
    permdock,
    getSnapshot,
    protect,
    protectOn: (instance, permission, load, protectOptions = {}, request) =>
      guardOn(instance, undefined, request, permission, load, protectOptions),
    connection,
    problem: (decision, init) => problemFor(decision, init, options.approval),
    openapi,
    permdockHandler,
  };
}
