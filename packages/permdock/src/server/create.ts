import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { ApprovalHint } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
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
};

export type Guard<T = unknown, V extends PolicyVocabulary = PolicyVocabulary> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly decision: Extract<Decision, { readonly outcome: "granted" }>;
      readonly data: T;
    }
  | { readonly ok: false; readonly response: Response };

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
export type ServerKernel<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: (
    request: Request,
    scope?: TenantScope,
  ) => Promise<PermDock<V>>;
  readonly protect: <T = unknown>(
    permission: Permission,
    loadData?: (
      request: Request,
    ) => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
  ) => (request: Request, scope?: TenantScope) => Promise<Guard<T, V>>;
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
  readonly protect: <T = unknown>(
    permission: Permission,
    loadData?: (
      request: Request,
    ) => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
  ) => (request: Request) => Promise<Guard<T, V>>;
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

  const protect =
    <T = unknown>(
      permission: Permission,
      loadData?: (
        request: Request,
      ) => T | null | undefined | Promise<T | null | undefined>,
      protectOptions: ProtectOptions = {},
    ) =>
    async (request: Request, scope?: TenantScope): Promise<Guard<T, V>> => {
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
      let data: T | undefined;
      if (loadData !== undefined) {
        const loaded = await loadData(request);
        if (loaded === null || loaded === undefined) {
          return { ok: false, response: notFoundProblem() };
        }
        data = loaded;
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
            credentials: request.headers.has("authorization"),
            scope: challengeScope(policy, permission),
            disclosure:
              data === undefined
                ? undefined
                : policy.resources.get(permission.resource)?.disclosure,
          }),
        ),
      };
    };

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
    protect,
    connection,
    problem: (decision, init) => problemFor(decision, init, options.approval),
    openapi,
    permdockHandler,
  };
}
