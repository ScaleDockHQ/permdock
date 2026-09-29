import { io } from 'next/cache.js';
import { forbidden, unauthorized, unstable_rethrow } from 'next/navigation.js';
import { after } from 'next/server.js';
import { cache, type ReactElement } from 'react';

import type { Decision } from '../core/decision.ts';
import type { DecisionSink, Snapshot } from '../core/interfaces.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy, PolicyVocabulary } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';
import type {
  GetPermDockQuery,
  NextPermDock,
  NextPermDockOptions,
  NextSubjectInput,
  ServerPermissionState,
  ServerPermDockProviderProps,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { emptySnapshot } from '../core/from-snapshot.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createEvaluationsHandler } from './handler.ts';
import { renderClientProvider } from './provider.tsx';

type GrantedDecision = Extract<Decision, { readonly outcome: 'granted' }>;

const DENIED: Decision = {
  outcome: 'denied',
  denials: [{ role: null, reason: 'no-grant' }],
  alternatives: [],
};

function assertServerOnly(): void {
  const globals = globalThis as typeof globalThis & {
    readonly document?: unknown;
  };
  if (globals.document !== undefined) {
    throw new TypeError(
      'permdock/next is server-only. Import hooks and Protected from permdock/react.',
    );
  }
}

async function readTenant(
  tenant: NextPermDockOptions['tenant'],
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === 'string') {
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
  dock: PermDock<V>,
  onDenied: NextPermDockOptions['onDenied'],
): PermDock<V> {
  if (onDenied === undefined) {
    return dock;
  }
  const assert = ((
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) =>
    (
      dock.assert as (
        next: Permission,
        row?: unknown,
        nextOptions?: DecideOptions,
      ) => ReturnType<PermDock<V>['assert']>
    )(
      permission,
      data,
      compact({
        ...options,
        onDenied: options?.onDenied ?? onDenied,
      }),
    )) as PermDock<V>['assert'];
  return { ...dock, assert };
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

  const resolveSubject = cache(async (): Promise<TUser | null> => {
    try {
      return await options.subject();
    } catch (error) {
      unstable_rethrow(error);
      return null;
    }
  });

  const resolveFallbackTenant = cache((): Promise<string | undefined> =>
    readTenant(options.tenant),
  );

  const instantiate = cache(async (tenantKey: string): Promise<PermDock<V>> => {
    const tenant = tenantKey === '' ? undefined : tenantKey;
    const user = await resolveSubject();
    // Decisions read the clock (membership and token expiry), so the instance
    // is created past a dynamic boundary; inside a cache scope this resolves at once.
    await io();
    const instance = applyOtel(
      await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          memberships: options.memberships,
          customRoles: options.customRoles,
          policies: options.policies,
          sink,
          limits: options.limits,
        }),
      ),
      options.otel,
    ) as PermDock<V>;
    return wrapInstance(instance, options.onDenied);
  });

  const getPermDock = async (
    query?: GetPermDockQuery,
  ): Promise<PermDock<V>> => {
    const tenant = query?.tenant ?? (await resolveFallbackTenant());
    return instantiate(tenant ?? '');
  };

  const getPermission = async (
    permission: Permission,
    data?: unknown,
  ): Promise<ServerPermissionState> => {
    try {
      const dock = await getPermDock();
      const decision = (
        dock.decide as (next: Permission, row?: unknown) => Decision
      )(permission, data);
      return {
        allowed: decision.outcome === 'granted',
        status: 'ready',
        decision,
      };
    } catch {
      return { allowed: false, status: 'ready', decision: DENIED };
    }
  };

  const requireAccess = async (
    permission: Permission,
    data?: unknown,
    query?: GetPermDockQuery,
  ): Promise<GrantedDecision> => {
    const dock = await getPermDock(query);
    const assert = dock.assert as (
      next: Permission,
      row?: unknown,
      nextOptions?: DecideOptions,
    ) => GrantedDecision;
    return assert(permission, data, {
      onDenied: (decision) => {
        if (
          decision.outcome !== 'denied' ||
          decision.denials.some((denial) => denial.reason === 'validation')
        ) {
          return;
        }
        if (dock.subject.principal === null) {
          unauthorized();
        }
        forbidden();
      },
    });
  };

  const PermDockProvider = (
    props: ServerPermDockProviderProps,
  ): ReactElement => {
    const snapshotPromise = getPermDock(
      props.tenant === undefined ? undefined : { tenant: props.tenant },
    )
      .then((dock): Snapshot | string | Promise<string> =>
        dock.snapshot(
          compact({
            include: props.include,
            tenants: props.tenants,
          }),
        ),
      )
      .catch((): Snapshot => emptySnapshot());
    return renderClientProvider(
      compact({
        snapshotPromise,
        endpoint: props.endpoint ?? options.endpoint ?? '/api/permdock',
        tenant: props.tenant,
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
    requireAccess,
    PermDockProvider,
    permdockHandler,
  };
}
