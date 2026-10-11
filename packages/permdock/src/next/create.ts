import { forbidden, unauthorized, unstable_rethrow } from "#next/navigation";
import { cacheLife, cacheTag, io } from "next/cache.js";
import { after } from "next/server.js";
import { cache, type ReactElement } from "react";

import type { DecisionSink } from "../core/interfaces.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Principal } from "../core/subject.ts";
import type {
  GetPermDockQuery,
  GetSnapshotQuery,
  NextPermDock,
  NextPermDockOptions,
  NextSubjectInput,
  RequireAccessInput,
  ServerPermissionState,
  ServerPermDockProviderProps,
} from "./types.ts";

import { buildInstance, resolveOrNull } from "../core/build-instance.ts";
import { compact } from "../core/compact.ts";
import { type Decision, NO_GRANT } from "../core/decision.ts";
import { cacheLifeFor, snapshotTag } from "../core/snapshot-cache.ts";
import { wrapPermDock } from "../core/wrap.ts";
import { createEvaluationsHandler } from "../server/evaluations.ts";
import { renderClientProvider } from "./provider.tsx";

type GrantedDecision = Extract<Decision, { readonly outcome: "granted" }>;

function assertServerOnly(): void {
  // SAFETY: document is only compared with undefined, so runtimes without it read undefined.
  const globals = globalThis as typeof globalThis & {
    readonly document?: unknown;
  };
  if (globals.document !== undefined) {
    throw new TypeError(
      "permdock/next is server-only. Import hooks and Protected from permdock/react.",
    );
  }
}

async function readTenant(
  tenant: NextPermDockOptions["tenant"],
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === "string") {
    return tenant;
  }
  try {
    return await tenant();
  } catch (error) {
    unstable_rethrow(error);
    return undefined;
  }
}

/** False outside a request or prerender scope, where `after()` throws. */
function defer(task: Promise<unknown> | (() => unknown)): boolean {
  try {
    after(task);
    return true;
  } catch {
    return false;
  }
}

function ignore(): undefined {
  return undefined;
}

/**
 * Keeps the function alive until the sink has written and flushed: every
 * pending write and one `flush()` per render run in `after()`, so serverless
 * runtimes do not freeze with events still buffered.
 */
function afterResponse(sink: DecisionSink): DecisionSink {
  const flush = sink.flush?.bind(sink);
  const scheduleFlush = cache((): boolean =>
    flush === undefined ? false : defer(flush),
  );
  return {
    write(events) {
      const written = sink.write(events);
      if (written !== undefined) {
        defer(Promise.resolve(written).then(ignore, ignore));
      }
      scheduleFlush();
      return written;
    },
    ...(flush === undefined ? {} : { flush }),
  };
}

function wrapInstance<V extends PolicyVocabulary>(
  permdock: PermDock<V>,
  onDenied: NextPermDockOptions["onDenied"],
): PermDock<V> {
  if (onDenied === undefined) {
    return permdock;
  }
  return wrapPermDock(permdock, (inner) => ({
    // SAFETY: assert's instance and collection overloads share one implementation that takes either kind.
    assert: ((
      permission: Permission,
      data?: unknown,
      options?: DecideOptions,
    ) =>
      (
        inner.assert as (
          next: Permission,
          row?: unknown,
          nextOptions?: DecideOptions,
        ) => ReturnType<PermDock<V>["assert"]>
      )(
        permission,
        data,
        compact({
          ...options,
          onDenied: options?.onDenied ?? onDenied,
        }),
      )) as PermDock<V>["assert"],
  }));
}

export function createPermDock<
  TUser = NextSubjectInput,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: NextPermDockOptions<TUser>,
): NextPermDock<V> {
  assertServerOnly();

  const sink =
    options.sink === undefined ? undefined : afterResponse(options.sink);

  const resolveSubject = cache((): Promise<TUser | null> =>
    resolveOrNull(() => options.subject(), unstable_rethrow),
  );

  const decorate = (permdock: PermDock<V>): PermDock<V> => {
    const traced =
      options.otel === undefined ? permdock : options.otel(permdock);
    const wrapped = options.wrap === undefined ? traced : options.wrap(traced);
    return wrapInstance(wrapped, options.onDenied);
  };

  const resolveFallbackTenant = cache((): Promise<string | undefined> =>
    readTenant(options.tenant),
  );

  const instantiate = cache(async (tenantKey: string): Promise<PermDock<V>> => {
    const tenant = tenantKey === "" ? undefined : tenantKey;
    const user = await resolveSubject();
    // Decisions read the clock (membership and token expiry), so the instance
    // is created past a dynamic boundary; inside a cache scope this resolves at once.
    await io();
    const built = await buildInstance({
      policy,
      user,
      sources: options,
      scope: { tenant, sink },
      wrap: decorate,
    });
    return built.permdock;
  });

  const getPermDock = async (
    query?: GetPermDockQuery,
  ): Promise<PermDock<V>> => {
    const tenant = query?.tenant ?? (await resolveFallbackTenant());
    return instantiate(tenant ?? "");
  };

  const getPermission = async (
    permission: Permission,
    data?: unknown,
    query?: GetPermDockQuery,
  ): Promise<ServerPermissionState> => {
    try {
      const permdock = await getPermDock(query);
      // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
      const decision = (
        permdock.decide as (next: Permission, row?: unknown) => Decision
      )(permission, data);
      return {
        allowed: decision.outcome === "granted",
        status: "ready",
        decision,
      };
    } catch (error) {
      unstable_rethrow(error);
      return { allowed: false, status: "ready", decision: NO_GRANT };
    }
  };

  const getSnapshot = async (
    query: GetSnapshotQuery = {},
  ): Promise<Snapshot> => {
    const permdock = await getPermDock(compact({ tenant: query.tenant }));
    const snapshot = permdock.snapshot(
      compact({ include: query.include, tenants: query.tenants }),
    );
    try {
      cacheLife(cacheLifeFor(snapshot));
      cacheTag(
        snapshotTag(permdock.subject.principal?.id),
        ...(query.tags ?? []),
      );
    } catch (error) {
      unstable_rethrow(error);
      throw new Error(
        "PermDock: getSnapshot() sets cacheLife() and cacheTag(), so call it inside a 'use cache: private' function with cacheComponents enabled.",
        { cause: error },
      );
    }
    return snapshot;
  };

  const requireAccess = async (
    input: RequireAccessInput,
  ): Promise<GrantedDecision> => {
    const permdock = await getPermDock(
      input.tenant === undefined ? undefined : { tenant: input.tenant },
    );
    // SAFETY: assert's instance and collection overloads share one implementation that takes either kind.
    const assert = permdock.assert as (
      next: Permission,
      row?: unknown,
      nextOptions?: DecideOptions,
    ) => GrantedDecision;
    const handler = input.onDenied ?? options.onDenied;
    return assert(input.permission, input.data, {
      onDenied: (decision) => {
        handler?.(decision);
        if (
          decision.outcome !== "denied" ||
          decision.denials.some((denial) => denial.reason === "validation")
        ) {
          return;
        }
        if (permdock.subject.principal === null) {
          unauthorized();
        }
        forbidden();
      },
    });
  };

  const PermDockProvider = (
    props: ServerPermDockProviderProps,
  ): ReactElement => {
    // A rejection reaches the client store as `server-only`, or with
    // `suspend` the nearest error boundary; Next.js interrupts keep working.
    const snapshotPromise = getPermDock(
      props.tenant === undefined ? undefined : { tenant: props.tenant },
    ).then((permdock): Snapshot | string | Promise<string> =>
      permdock.snapshot(
        compact({
          include: props.include,
          tenants: props.tenants,
        }),
      ),
    );
    return renderClientProvider(
      compact({
        snapshotPromise,
        endpoint: props.endpoint ?? options.endpoint ?? "/api/permdock",
        tenant: props.tenant,
        suspend: props.suspend,
        defaults: props.defaults,
        messages: props.messages,
        children: props.children,
      }),
    );
  };

  const permdockHandler = (): ReturnType<typeof createEvaluationsHandler> =>
    createEvaluationsHandler(
      compact({
        policy,
        getPermDock,
        store: options.store,
      }),
    );

  return {
    getPermDock,
    getPermission,
    getSnapshot,
    requireAccess,
    PermDockProvider,
    permdockHandler,
  };
}
