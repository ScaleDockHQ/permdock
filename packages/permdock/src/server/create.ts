import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Actor, Principal } from "../core/subject.ts";
import type { PdpPermDock } from "../pdp/types.ts";
import type { Connection, ConnectionOptions } from "./connection.ts";
import type {
  Built,
  Guard,
  Loader,
  OpenApiHooks,
  Protect,
  ProtectOptions,
  Resolved,
  ScopeGuard,
  ServerKernel,
  ServerKernelOptions,
  ServerPermDock,
  ServerPermDockOptions,
  SnapshotQuery,
} from "./server-types.ts";

import {
  type TenantOption,
  type TenantScope,
  actorFrom,
  tenantScope,
} from "../core/adapter-context.ts";
import { instanceOptions } from "../core/instance-options.ts";
import {
  type PermDock,
  createPermDock as createCorePermDock,
} from "../core/permdock.ts";
import { listPermissions } from "../core/permission-registry.ts";
import { problemFor } from "./kernel-problems.ts";
import { InvalidSignatureError } from "./web-bot-auth.ts";

export { tenantScope };
export type { TenantOption, TenantScope };

import { compact } from "../core/compact.ts";
import {
  errorChannel,
  requestContext,
  type Report,
  type RequestContext,
} from "../core/request-context.ts";
import { createEvaluationsHandler } from "./evaluations.ts";
import { type RouteGuardDeps, guardOn, routeScopes } from "./route-guard.ts";

export type { RequestContext };

async function resolveActor(
  request: Request,
  options: Pick<ServerPermDockOptions, "actor" | "webBotAuth">,
): Promise<Actor | undefined> {
  const verified =
    options.webBotAuth === undefined
      ? undefined
      : await options.webBotAuth(request);
  return verified ?? actorFrom(options.actor, request);
}

const NO_TENANT = "\u0000";

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ServerPermDockOptions<TUser>,
): ServerPermDock<V> {
  return createServerKernel<TUser, TPrincipal, V>(policy, options);
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

  const freshSubject = async (request: Request): Promise<Resolved<TUser>> => {
    const actor = await resolveActor(request, options);
    const errors: unknown[] = [];
    const context = await requestContext(options.context, request, errors);
    try {
      return { user: await options.subject(request), actor, context, errors };
    } catch {
      return { user: null, actor, context, errors };
    }
  };

  const resolveSubject = (request: Request): Promise<Resolved<TUser>> => {
    const hit = subjects.get(request);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = freshSubject(request);
    subjects.set(request, resolved);
    return resolved;
  };

  const reporters = new WeakMap<PermDock<V>, Report>();

  const instanceFor = async (
    { user, actor, context, errors }: Resolved<TUser>,
    tenant: string | undefined,
  ): Promise<Built<V>> => {
    const coreOptions = compact({
      tenant,
      ...instanceOptions(options),
      actor,
      context,
    });
    const channel = errorChannel(errors);
    const permdock = channel.attach(
      await createCorePermDock(policy, user, coreOptions),
    );
    const remote =
      options.pdp === undefined
        ? undefined
        : await options.pdp(policy, user, coreOptions);
    const wrapped =
      options.wrap === undefined ? permdock : options.wrap(permdock);
    reporters.set(wrapped, channel.report);
    return { permdock: wrapped, remote, report: channel.report };
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

  const deps: RouteGuardDeps<V> = {
    // SAFETY: the guard reads the policy's resources and scopes, which do not depend on TUser or TPrincipal.
    policy: policy as unknown as Policy,
    options,
    adapter,
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
      let report: Report;
      try {
        ({ permdock: instance, remote, report } = await build(request, scope));
      } catch (error) {
        if (error instanceof InvalidSignatureError) {
          return { ok: false, response: error.response };
        }
        throw error;
      }
      return guardOn<T, V>(
        deps,
        instance,
        remote,
        report,
        request,
        permission,
        loadData === undefined
          ? undefined
          : (): ReturnType<Loader<T>> => loadData(request),
        protectOptions,
      );
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
      guardOn(
        deps,
        instance,
        undefined,
        reporters.get(instance) ?? ((): void => undefined),
        request,
        permission,
        load,
        protectOptions,
      ),
    connection,
    shareSubject: (from, to) => {
      const resolved = subjects.get(from);
      if (resolved !== undefined && !subjects.has(to)) {
        subjects.set(to, resolved);
      }
    },
    problem: (decision, init) => problemFor(decision, init, options.approval),
    openapi,
    permdockHandler,
  };
}
