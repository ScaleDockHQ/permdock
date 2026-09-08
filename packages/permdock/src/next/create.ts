import { cache, type ReactElement } from 'react';

import type { Decision } from '../core/decision.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type {
  GetPermDockQuery,
  NextPermDock,
  NextPermDockOptions,
  ServerPermissionState,
  ServerPermDockProviderProps,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { createHandler } from './handler.ts';
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

function wrapInstance(
  dock: PermDock,
  onDenied: NextPermDockOptions['onDenied'],
): PermDock {
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
      ) => ReturnType<PermDock['assert']>
    )(
      permission,
      data,
      compact({
        ...options,
        onDenied: options?.onDenied ?? onDenied,
      }),
    )) as PermDock['assert'];
  return { ...dock, assert };
}

export function createPermDock(
  policy: Policy,
  options: NextPermDockOptions,
): NextPermDock {
  assertServerOnly();

  const resolveSubject = cache(async (): Promise<unknown> => {
    try {
      return await options.subject();
    } catch {
      return null;
    }
  });

  const resolveFallbackTenant = cache((): Promise<string | undefined> =>
    readTenant(options.tenant),
  );

  const instantiate = cache(async (tenantKey: string): Promise<PermDock> => {
    const tenant = tenantKey === '' ? undefined : tenantKey;
    const user = await resolveSubject();
    const instance = await createCorePermDock(
      policy,
      user,
      compact({
        tenant,
        memberships: options.memberships,
        customRoles: options.customRoles,
        sink: options.sink,
      }),
    );
    return wrapInstance(instance, options.onDenied);
  });

  const getPermDock = async (query?: GetPermDockQuery): Promise<PermDock> => {
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

  const PermDockProvider = async (
    props: ServerPermDockProviderProps,
  ): Promise<ReactElement> => {
    const dock = await getPermDock(
      props.tenant === undefined ? undefined : { tenant: props.tenant },
    );
    const snapshot = await Promise.resolve(
      dock.snapshot(
        compact({
          include: props.include,
          tenants: props.tenants,
        }),
      ),
    );
    return renderClientProvider(
      compact({
        snapshot,
        endpoint: props.endpoint ?? options.endpoint ?? '/api/permdock',
        tenant: props.tenant,
        children: props.children,
      }),
    );
  };

  const permdockHandler = (): ReturnType<typeof createHandler> =>
    createHandler(
      compact({
        policy,
        getPermDock,
        store: options.store,
      }),
    );

  return { getPermDock, getPermission, PermDockProvider, permdockHandler };
}
