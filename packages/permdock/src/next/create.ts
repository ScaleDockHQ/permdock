import { cache, type ReactElement } from 'react';

import type { Decision } from '../core/decision.ts';
import type { Snapshot } from '../core/interfaces.ts';
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
  } catch {
    return undefined;
  }
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

  const resolveSubject = cache(async (): Promise<TUser | null> => {
    try {
      return await options.subject();
    } catch {
      return null;
    }
  });

  const resolveFallbackTenant = cache((): Promise<string | undefined> =>
    readTenant(options.tenant),
  );

  const instantiate = cache(async (tenantKey: string): Promise<PermDock<V>> => {
    const tenant = tenantKey === '' ? undefined : tenantKey;
    const user = await resolveSubject();
    const instance = applyOtel(
      await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          memberships: options.memberships,
          customRoles: options.customRoles,
          sink: options.sink,
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

  return { getPermDock, getPermission, PermDockProvider, permdockHandler };
}
