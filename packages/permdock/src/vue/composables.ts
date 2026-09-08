import {
  computed,
  inject,
  onScopeDispose,
  shallowRef,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Membership } from '../core/subject.ts';
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

import { permDockKey } from './context.ts';

function useStore(): ClientStore {
  const store = inject(permDockKey);
  if (store === undefined) {
    throw new Error('PermDock: composables require permdockPlugin.');
  }
  return store;
}

function useTick(store: ClientStore): ComputedRef<ClientPermDock> {
  const tick = shallowRef(0);
  onScopeDispose(
    store.subscribe(() => {
      tick.value += 1;
    }),
  );
  return computed(() => {
    void tick.value;
    return store.get();
  });
}

export function usePermDock(): ClientPermDock {
  const store = useStore();
  const dock = useTick(store);
  return new Proxy({} as ClientPermDock, {
    get(_target, prop, _receiver): unknown {
      return Reflect.get(dock.value, prop);
    },
  });
}

export function usePermission(
  permission: Permission,
  data?: MaybeRefOrGetter<unknown>,
): {
  readonly allowed: ComputedRef<boolean>;
  readonly status: ComputedRef<PermissionState['status']>;
  readonly decision: ComputedRef<Decision>;
} {
  const store = useStore();
  const dock = useTick(store);
  const state = computed(() => {
    void dock.value;
    return store.permissionState(permission, toValue(data));
  });
  return {
    allowed: computed(() => state.value.allowed),
    status: computed(() => state.value.status),
    decision: computed(() => state.value.decision),
  };
}

export function usePermissions(
  permissions: MaybeRefOrGetter<readonly Permission[]>,
  data?: MaybeRefOrGetter<unknown>,
): ComputedRef<PermissionSet> {
  const store = useStore();
  const dock = useTick(store);
  return computed(() => {
    void dock.value;
    const granted: Permission[] = [];
    const byKey: Record<string, PermissionState> = {};
    for (const permission of toValue(permissions)) {
      const next = store.permissionState(permission, toValue(data));
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
  rows: MaybeRefOrGetter<readonly T[]>,
): ComputedRef<FilterResult<T>> {
  const dock = useTick(useStore());
  return computed(() => {
    const filtered = dock.value.filter(permission, toValue(rows));
    const result = [...filtered] as T[] & { partial: boolean };
    result.partial = dock.value.where(permission).partial;
    return result;
  });
}

export function useTenant(): ComputedRef<TenantView> {
  const dock = useTick(useStore());
  return computed(() => ({
    tenant: dock.value.subject.principal?.tenant ?? null,
    tenants: dock.value.tenants(),
    switchTo: (id: string) => dock.value.refresh({ tenant: id }),
    status: dock.value.status(),
  }));
}

export function useMemberships(): ComputedRef<readonly Membership[]> {
  const dock = useTick(useStore());
  return computed(() => dock.value.memberships());
}

export function useRoles(
  options: MaybeRefOrGetter<UseRolesOptions> = {},
): ComputedRef<{ readonly roles: readonly string[] }> {
  const dock = useTick(useStore());
  return computed(() => {
    const next = toValue(options);
    const scoped =
      next.team === undefined ? dock.value : dock.value.team(next.team);
    return {
      roles: scoped.roles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function useAssignableRoles(): ComputedRef<readonly string[]> {
  const dock = useTick(useStore());
  return computed(() => dock.value.assignable());
}

export function useSubject(): ComputedRef<SubjectView> {
  const dock = useTick(useStore());
  return computed(() => {
    const snapshot = dock.value.snapshot();
    const simulated =
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'simulated' in snapshot &&
      snapshot.simulated === true;
    return {
      principal: dock.value.subject.principal,
      actor: dock.value.subject.actor,
      delegation: dock.value.subject.delegation,
      expiresAt: dock.value.subject.expiresAt,
      simulated,
    };
  });
}

export function useApproval(
  decision: MaybeRefOrGetter<Decision>,
): ComputedRef<ApprovalHandle> {
  const store = useStore();
  return computed(() => {
    const next = toValue(decision);
    let state: ApprovalState = 'not-needed';
    if (next.outcome === 'approval-required') {
      state = 'required';
    }
    return {
      state,
      token: next.outcome === 'approval-required' ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
