import { use, useMemo, useSyncExternalStore } from "react";

import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { PolicyVocabulary } from "../core/policy.ts";
import type { Membership } from "../core/subject.ts";
import type { Role } from "../core/vocabulary.ts";
import type { ClientStore } from "./store.ts";
import type {
  ApprovalHandle,
  ClientPermDock,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from "./types.ts";

import {
  approvalHandle,
  filterResult,
  permissionSet,
  rolesView,
  subjectView,
  tenantView,
} from "../client/views.ts";
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
} from "./context.ts";
import { storeOf } from "./store.ts";

function useStore(): ClientStore {
  const store = use(PermDockStoreContext);
  if (store === null) {
    throw new Error("PermDock: hooks require <PermDockProvider>.");
  }
  const pending = use(PermDockSnapshotPromiseContext);
  if (pending !== null) {
    store.adopt(use(pending), pending);
  }
  return store;
}

export function usePermDock<
  V extends PolicyVocabulary = PolicyVocabulary,
>(): ClientPermDock<V> {
  const store = useStore();
  // SAFETY: V only types the vocabulary; the store holds the instance for the provider's policy.
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  ) as ClientPermDock<V>;
}

// The hooks reach the store through `permdock`: the React Compiler keeps only
// the dependencies a memoised callback reads, and `permdock` is the one that
// changes when the store does.
export function usePermission(
  permission: Permission,
  data?: unknown,
): PermissionState {
  const permdock = usePermDock();
  return useMemo(
    () => storeOf(permdock).permissionState(permission, data),
    [permdock, permission, data],
  );
}

export function usePermissions(
  permissions: readonly Permission[],
  data?: unknown,
): PermissionSet {
  const permdock = usePermDock();
  return useMemo(
    () => permissionSet(storeOf(permdock), permissions, data),
    [permdock, permissions, data],
  );
}

export function useFilter<T>(
  permission: Permission<string, T, "instance">,
  rows: readonly T[],
): FilterResult<T> {
  const permdock = usePermDock();
  return useMemo(
    () => filterResult(permdock, permission, rows),
    [permdock, permission, rows],
  );
}

export function useTenant(): TenantView {
  return tenantView(usePermDock());
}

export function useMemberships(): readonly Membership[] {
  return usePermDock().memberships();
}

export function useRoles(options: UseRolesOptions = {}): {
  readonly roles: readonly Role[];
} {
  return rolesView(usePermDock(), options);
}

export function useAssignableRoles(): readonly Role[] {
  return usePermDock().assignableRoles();
}

export function useAssignablePermissions(
  options: { readonly tenant?: string } = {},
): readonly Permission[] {
  return usePermDock().assignablePermissions(options);
}

export function useSubject(): SubjectView {
  return subjectView(usePermDock());
}

export function useApproval(decision: Decision): ApprovalHandle {
  return approvalHandle(storeOf(usePermDock()), decision);
}
