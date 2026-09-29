import { createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Membership } from '../core/subject.ts';
import type { Role } from '../core/vocabulary.ts';
import type { ClientStore } from '../react/store.ts';
import type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from './types.ts';

import { useStore } from './context.ts';

function useVersion(store: ClientStore): Accessor<number> {
  const [tick, setTick] = createSignal(0);
  onCleanup(
    store.subscribe(() => {
      setTick((current) => current + 1);
    }),
  );
  return tick;
}

export function usePermDock(): ClientPermDock {
  const store = useStore();
  const version = useVersion(store);
  return new Proxy({} as ClientPermDock, {
    get(_target, prop, _receiver): unknown {
      version();
      return Reflect.get(store.get(), prop);
    },
  });
}

export function usePermission(
  permission: Permission | Accessor<Permission>,
  data?: Accessor<unknown>,
): Accessor<PermissionState> {
  const store = useStore();
  const version = useVersion(store);
  return createMemo(() => {
    version();
    const current =
      typeof permission === 'function' ? permission() : permission;
    return store.permissionState(current, data?.());
  });
}

export function usePermissions(
  permissions: Accessor<readonly Permission[]>,
  data?: Accessor<unknown>,
): Accessor<PermissionSet> {
  const store = useStore();
  const version = useVersion(store);
  return createMemo(() => {
    version();
    const granted: Permission[] = [];
    const byKey: Record<string, PermissionState> = {};
    for (const permission of permissions()) {
      const next = store.permissionState(permission, data?.());
      byKey[permission.key] = next;
      if (next.allowed) {
        granted.push(permission);
      }
    }
    const base: PermissionSet = {
      granted,
      get(permission: Permission): PermissionState | undefined {
        return byKey[permission.key];
      },
    };
    return new Proxy(base, {
      get(target, prop, receiver): unknown {
        if (typeof prop === 'string' && Object.hasOwn(byKey, prop)) {
          return byKey[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
}

export function useFilter<T>(
  permission: Permission<string, T, 'instance'>,
  rows: Accessor<readonly T[]>,
): Accessor<FilterResult<T>> {
  const dock = usePermDock();
  return createMemo(() => {
    const next = dock.filter(permission, rows()) as T[] & { partial: boolean };
    next.partial = dock.where(permission).partial;
    return next;
  });
}

export function useTenant(): Accessor<TenantView> {
  const dock = usePermDock();
  return createMemo(() => ({
    tenant: dock.subject.principal?.tenant ?? null,
    tenants: dock.tenants(),
    switchTo: (id: string) => dock.refresh({ tenant: id }),
    status: dock.status(),
  }));
}

export function useMemberships(): Accessor<readonly Membership[]> {
  const dock = usePermDock();
  return createMemo(() => dock.memberships());
}

export function useRoles(
  options: Accessor<UseRolesOptions> = () => ({}),
): Accessor<{ readonly roles: readonly Role[] }> {
  const dock = usePermDock();
  return createMemo(() => {
    const next = options();
    const scoped = next.team === undefined ? dock : dock.team(next.team);
    return {
      roles: scoped.heldRoles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function useAssignableRoles(): Accessor<readonly Role[]> {
  const dock = usePermDock();
  return createMemo(() => dock.assignableRoles());
}

export function useAssignablePermissions(
  options: { readonly tenant?: string } = {},
): Accessor<readonly Permission[]> {
  const dock = usePermDock();
  return createMemo(() => dock.assignablePermissions(options));
}

export function useSubject(): Accessor<SubjectView> {
  const dock = usePermDock();
  return createMemo(() => {
    const snapshot = dock.snapshot();
    const simulated =
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'simulated' in snapshot &&
      snapshot.simulated === true;
    return {
      principal: dock.subject.principal,
      actor: dock.subject.actor,
      delegation: dock.subject.delegation,
      expiresAt: dock.subject.expiresAt,
      simulated,
    };
  });
}

export function useApproval(
  decision: Accessor<Decision>,
): Accessor<ApprovalHandle> {
  const store = useStore();
  const version = useVersion(store);
  return createMemo(() => {
    version();
    const next = decision();
    const state: ApprovalState = store.approvalState(next);
    return {
      state,
      token: next.outcome === 'approval-required' ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
