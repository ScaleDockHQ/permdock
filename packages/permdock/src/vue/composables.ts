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
  const permdock = useTick(store);
  // SAFETY: the empty target is never read; the get trap answers from the store's current instance.
  return new Proxy({} as ClientPermDock, {
    get(_target, prop, _receiver): unknown {
      return Reflect.get(permdock.value, prop);
    },
  });
}

export function usePermission(
  permission: MaybeRefOrGetter<Permission>,
  data?: MaybeRefOrGetter<unknown>,
): {
  readonly allowed: ComputedRef<boolean>;
  readonly status: ComputedRef<PermissionState['status']>;
  readonly decision: ComputedRef<Decision>;
} {
  const store = useStore();
  const permdock = useTick(store);
  const state = computed(() => {
    void permdock.value;
    return store.permissionState(toValue(permission), toValue(data));
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
  const permdock = useTick(store);
  return computed(() => {
    void permdock.value;
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
  const permdock = useTick(useStore());
  return computed(() => {
    const filtered = permdock.value.filter(permission, toValue(rows));
    // SAFETY: a fresh copy; the next line sets partial on it.
    const result = [...filtered] as T[] & { partial: boolean };
    result.partial = permdock.value.where(permission).partial;
    return result;
  });
}

export function useTenant(): ComputedRef<TenantView> {
  const permdock = useTick(useStore());
  return computed(() => ({
    tenant: permdock.value.subject.principal?.tenant ?? null,
    tenants: permdock.value.tenants(),
    switchTo: (id: string) => permdock.value.refresh({ tenant: id }),
    status: permdock.value.status(),
  }));
}

export function useMemberships(): ComputedRef<readonly Membership[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.memberships());
}

export function useRoles(
  options: MaybeRefOrGetter<UseRolesOptions> = {},
): ComputedRef<{ readonly roles: readonly Role[] }> {
  const permdock = useTick(useStore());
  return computed(() => {
    const next = toValue(options);
    const scoped =
      next.team === undefined ? permdock.value : permdock.value.team(next.team);
    return {
      roles: scoped.heldRoles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function useAssignableRoles(): ComputedRef<readonly Role[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.assignableRoles());
}

export function useAssignablePermissions(
  options: { readonly tenant?: string } = {},
): ComputedRef<readonly Permission[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.assignablePermissions(options));
}

export function useSubject(): ComputedRef<SubjectView> {
  const permdock = useTick(useStore());
  return computed(() => {
    const snapshot = permdock.value.snapshot();
    const simulated =
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'simulated' in snapshot &&
      snapshot.simulated === true;
    return {
      principal: permdock.value.subject.principal,
      actor: permdock.value.subject.actor,
      delegation: permdock.value.subject.delegation,
      expiresAt: permdock.value.subject.expiresAt,
      simulated,
    };
  });
}

export function useApproval(
  decision: MaybeRefOrGetter<Decision>,
): ComputedRef<ApprovalHandle> {
  const store = useStore();
  const permdock = useTick(store);
  return computed(() => {
    void permdock.value;
    const next = toValue(decision);
    const state: ApprovalState = store.approvalState(next);
    return {
      state,
      token: next.outcome === 'approval-required' ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
