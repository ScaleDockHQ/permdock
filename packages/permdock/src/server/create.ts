import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { ApprovalHint } from '../core/errors.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  LimitStore,
  EntitlementSource,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { Actor, Principal } from '../core/subject.ts';
import type { PdpFactory, PdpPermDock } from '../pdp/types.ts';
import type { Connection, ConnectionOptions } from './connection.ts';
import type { WebBotAuthOptions } from './web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { listPermissions } from '../core/permissions.ts';
import { isActor } from '../core/subject.ts';
import { openConnection } from './connection.ts';
import {
  applyApprovalResume,
  createEvaluationsHandler,
} from './evaluations.ts';
import {
  PROBLEM_BASE,
  problemFromDecision,
  problemResponse,
} from './problem.ts';
import { InvalidSignatureError, verifyWebBotAuth } from './web-bot-auth.ts';

export type ServerPermDockOptions<TUser = unknown> = {
  readonly subject: (request: Request) => TUser | Promise<TUser>;
  readonly actor?: (request: Request) => unknown;
  readonly webBotAuth?: WebBotAuthOptions;
  readonly tenant?:
    | string
    | ((request: Request) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  /** Ends or revalidates open connections; never a decision input. */
  readonly revocations?: RevocationFeed;
  /**
   * `createPermDock` from `permdock/pdp`: `protect` then decides delegated
   * permissions through the remote PDP. The instance handlers receive stays
   * synchronous and keeps denying delegated permissions (`pdp-unavailable`).
   */
  readonly pdp?: PdpFactory;
  /** Accepted for adapter parity; HTTP adapters do not read it. */
  readonly snapshots?: SnapshotSource;
  /** Added as `approval` to every `approval-required` problem. */
  readonly approval?: ApprovalHint;
};

export type Guard<T = unknown> =
  | {
      readonly ok: true;
      readonly permdock: PermDock;
      readonly decision: Extract<Decision, { readonly outcome: 'granted' }>;
      readonly data: T;
    }
  | { readonly ok: false; readonly response: Response };

export type OpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly 'x-permdock-permissions': readonly string[];
  };
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
};

export type ProtectOptions = {
  /**
   * `false` when `loadData` returns request input (a body, query or header)
   * rather than a stored row: it is validated against the resource schema
   * before the check.
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
  if (option === undefined || typeof option === 'string') {
    return { tenant: option };
  }
  try {
    return { tenant: await option(context) };
  } catch {
    return { tenant: undefined };
  }
}

export type Kernel = {
  readonly permdock: (
    request: Request,
    scope?: TenantScope,
  ) => Promise<PermDock>;
  readonly protect: <T = unknown>(
    permission: Permission,
    loadData?: (
      request: Request,
    ) => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
  ) => (request: Request, scope?: TenantScope) => Promise<Guard<T>>;
  readonly connection: <T = unknown>(
    request: Request,
    options?: ConnectionOptions<T>,
    scope?: TenantScope,
  ) => Promise<Connection>;
  readonly problem: ServerPermDock['problem'];
  readonly openapi: OpenApiHooks;
  readonly handler: (
    scope?: (request: Request) => TenantScope | Promise<TenantScope>,
  ) => ReturnType<typeof createEvaluationsHandler>;
};

export type ServerPermDock = {
  readonly permdock: (request: Request) => Promise<PermDock>;
  readonly protect: <T = unknown>(
    permission: Permission,
    loadData?: (
      request: Request,
    ) => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
  ) => (request: Request) => Promise<Guard<T>>;
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
  readonly handler: () => ReturnType<typeof createEvaluationsHandler>;
};

async function resolveActor(
  request: Request,
  options: ServerPermDockOptions,
): Promise<Actor | undefined> {
  const verified = await verifyWebBotAuth(request, options.webBotAuth);
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

type Built = {
  readonly dock: PermDock;
  readonly remote: PdpPermDock | undefined;
};

type Resolved<TUser> = {
  readonly user: TUser | null;
  readonly actor: Actor | undefined;
};

const NO_TENANT = '\u0000';

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ServerPermDockOptions<TUser>,
): ServerPermDock {
  return createKernel(policy, options);
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
      { principal: null, context: {} },
      compact({ instance: init.instance, approval }),
    );
  }
  return problemResponse({
    type: `${PROBLEM_BASE}/denied`,
    title: 'Permission denied',
    status: 403,
    detail: decision.outcome,
  });
}

/**
 * The kernel behind every HTTP adapter. The subject and actor are resolved
 * once per `Request`; one instance is cached per `(Request, tenant)`, so a
 * global middleware and a later tenant-scoped `protect` never share a tenant.
 */
export function createKernel<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ServerPermDockOptions<TUser> & {
    readonly wrap?: (dock: PermDock) => PermDock;
    readonly adapter?: string;
  },
): Kernel {
  const adapter = options.adapter ?? 'server';
  const subjects = new WeakMap<Request, Promise<Resolved<TUser>>>();
  const instances = new WeakMap<Request, Map<string, Promise<Built>>>();

  const resolveSubject = (request: Request): Promise<Resolved<TUser>> => {
    const hit = subjects.get(request);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = (async (): Promise<Resolved<TUser>> => {
      const actor = await resolveActor(request, options);
      let user: TUser | null = null;
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
  ): Promise<Built> => {
    const coreOptions = compact({
      tenant,
      memberships: options.memberships,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      sink: options.sink,
      limits: options.limits,
      actor,
    });
    const dock = await createCorePermDock(policy, user, coreOptions);
    const remote =
      options.pdp === undefined
        ? undefined
        : await options.pdp(policy, user, coreOptions);
    return {
      dock: options.wrap === undefined ? dock : options.wrap(dock),
      remote,
    };
  };

  const build = async (
    request: Request,
    scope?: TenantScope,
  ): Promise<Built> => {
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
    const built = (async (): Promise<Built> =>
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
    return openConnection<T>({
      open: async (): Promise<PermDock> =>
        (await build(request, { tenant })).dock,
      rebuild: async (): Promise<PermDock> =>
        (await instanceFor(await freshSubject(request), tenant)).dock,
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
  ): Promise<PermDock> => (await build(request, scope)).dock;

  const protect =
    <T = unknown>(
      permission: Permission,
      loadData?: (
        request: Request,
      ) => T | null | undefined | Promise<T | null | undefined>,
      protectOptions: ProtectOptions = {},
    ) =>
    async (request: Request, scope?: TenantScope): Promise<Guard<T>> => {
      let instance: PermDock;
      let remote: PdpPermDock | undefined;
      try {
        ({ dock: instance, remote } = await build(request, scope));
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
          return {
            ok: false,
            response: new Response(null, { status: 404 }),
          };
        }
        data = loaded;
      }
      const decideOptions = compact<DecideOptions>({
        source: 'adapter',
        adapter,
        ...(protectOptions.trusted === false
          ? { trusted: false, boundary: 'http-body' as const }
          : {}),
      });
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
                outcome: 'denied',
                denials: [{ role: null, reason: 'pdp-unavailable' }],
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
            typeof data === 'object' &&
            'id' in data &&
            (typeof (data as { readonly id?: unknown }).id === 'string' ||
              typeof (data as { readonly id?: unknown }).id === 'number')
              ? String((data as { readonly id: string | number }).id)
              : undefined,
        }),
        adapter,
      );
      if (decision.outcome === 'granted') {
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
          compact({ approval: options.approval }),
        ),
      };
    };

  const openapi: OpenApiHooks = {
    security: (permission: Permission) => ({
      security: [{ oauth2: [permission.scope] }],
      'x-permdock-permissions': [permission.key],
    }),
    securitySchemes: () => {
      const scopes: Record<string, string> = {};
      for (const leaf of listPermissions(policy.permissions)) {
        scopes[leaf.scope] = leaf.meta.title ?? leaf.key;
      }
      return {
        oauth2: {
          type: 'oauth2',
          flows: {},
          scopes,
        },
      };
    },
  };

  const handler = (
    scope?: (request: Request) => TenantScope | Promise<TenantScope>,
  ): ReturnType<typeof createEvaluationsHandler> =>
    createEvaluationsHandler(
      compact({
        policy,
        resolve:
          scope === undefined
            ? permdock
            : async (request: Request): Promise<PermDock> =>
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
    handler,
  };
}
