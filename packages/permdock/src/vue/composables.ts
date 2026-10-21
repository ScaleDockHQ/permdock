import type { ComputedRef, MaybeRefOrGetter } from "vue";

import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  shallowRef,
  toValue,
} from "vue";

import type { ClientStore } from "../client/store.ts";
import type { Decision } from "../core/decision.ts";
import type { DecisionDescription, DescribeOptions } from "../core/describe.ts";
import type { RowData, UncheckedData } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Membership } from "../core/subject.ts";
import type { Role } from "../core/vocabulary.ts";
import type {
  ApprovalHandle,
  ClientPermDock,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  RolesOptions,
} from "./types.ts";

import {
  approvalHandle,
  describeWith,
  filterResult,
  livePermDock,
  permissionSet,
  rolesView,
  subjectView,
  tenantView,
} from "../client/kit.ts";
import { permDockKey, permDockUiKey } from "./context.ts";

function useStore(): ClientStore {
  const store = inject(permDockKey);
  if (store === undefined) {
    throw new Error("PermDock: composables require permdockPlugin.");
  }
  return store;
}

function useTick(store: ClientStore): ComputedRef<ClientPermDock> {
  if (getCurrentScope() === undefined) {
    throw new Error(
      "PermDock: call composables in setup() or an effectScope, which removes their store subscription.",
    );
  }
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
  return livePermDock(() => permdock.value);
}

type PermissionRefs = {
  readonly allowed: ComputedRef<boolean>;
  readonly status: ComputedRef<PermissionState["status"]>;
  readonly decision: ComputedRef<Decision>;
};

export function usePermission<D>(
  permission: MaybeRefOrGetter<Permission>,
  data?: MaybeRefOrGetter<UncheckedData<D>>,
): PermissionRefs;
export function usePermission<P extends Permission>(
  permission: MaybeRefOrGetter<P>,
  data?: MaybeRefOrGetter<RowData<P>>,
): PermissionRefs;
export function usePermission(
  permission: MaybeRefOrGetter<Permission>,
  data?: MaybeRefOrGetter<unknown>,
): PermissionRefs {
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
    return permissionSet(store, toValue(permissions), toValue(data));
  });
}

export function useFilter<T>(
  permission: Permission<string, NoInfer<T>, "instance">,
  rows: MaybeRefOrGetter<readonly T[]>,
): ComputedRef<FilterResult<T>> {
  const permdock = useTick(useStore());
  return computed(() =>
    filterResult(permdock.value, permission, toValue(rows)),
  );
}

export function useTenant(): ComputedRef<TenantView> {
  const permdock = useTick(useStore());
  return computed(() => tenantView(permdock.value));
}

export function useMemberships(): ComputedRef<readonly Membership[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.memberships());
}

export function useRoles(
  options: MaybeRefOrGetter<RolesOptions> = {},
): ComputedRef<{ readonly roles: readonly Role[] }> {
  const permdock = useTick(useStore());
  return computed(() => rolesView(permdock.value, toValue(options)));
}

export function useAssignableRoles(): ComputedRef<readonly Role[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.assignableRoles());
}

export function useAssignablePermissions(
  options: MaybeRefOrGetter<{ readonly tenant?: string }> = {},
): ComputedRef<readonly Permission[]> {
  const permdock = useTick(useStore());
  return computed(() => permdock.value.assignablePermissions(toValue(options)));
}

export function useSubject(): ComputedRef<SubjectView> {
  const permdock = useTick(useStore());
  return computed(() => subjectView(permdock.value));
}

export function useApproval(
  decision: MaybeRefOrGetter<Decision>,
): ComputedRef<ApprovalHandle> {
  const store = useStore();
  const permdock = useTick(store);
  return computed(() => {
    void permdock.value;
    return approvalHandle(store, toValue(decision));
  });
}

/** `describe` with the plugin's `messages`; a call's own `messages` win. */
export function useDescribe(): (
  decision: Decision,
  options?: DescribeOptions,
) => DecisionDescription {
  return describeWith(inject(permDockUiKey, {}).messages);
}
