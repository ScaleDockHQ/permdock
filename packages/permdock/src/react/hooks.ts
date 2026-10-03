import { use, useMemo, useSyncExternalStore } from "react";

import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { PolicyVocabulary } from "../core/policy.ts";
import type { Membership } from "../core/subject.ts";
import type { Role } from "../core/vocabulary.ts";
import type { ClientStore } from "./store.ts";
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
} from "./types.ts";

import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
} from "./context.ts";

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

export function usePermission(
  permission: Permission,
  data?: unknown,
): PermissionState {
  const store = useStore();
  const permdock = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
  return useMemo(
    () => store.permissionState(permission, data),
    [store, permdock, permission, data],
  );
}

export function usePermissions(
  permissions: readonly Permission[],
  data?: unknown,
): PermissionSet {
  const store = useStore();
  const permdock = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
  return useMemo(() => {
    const granted: Permission[] = [];
    const byKey: Record<string, PermissionState> = {};
    for (const permission of permissions) {
      const state = store.permissionState(permission, data);
      byKey[permission.key] = state;
      if (state.allowed) {
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
        if (typeof prop === "string" && Object.hasOwn(byKey, prop)) {
          return byKey[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }, [store, permdock, permissions, data]);
}

export function useFilter<T>(
  permission: Permission<string, T, "instance">,
  rows: readonly T[],
): FilterResult<T> {
  const permdock = usePermDock();
  return useMemo(() => {
    const filtered = permdock.filter(permission, rows);
    // SAFETY: a fresh copy; the next line sets partial on it.
    const result = [...filtered] as T[] & { partial: boolean };
    result.partial = permdock.where(permission).partial;
    return result;
  }, [permdock, permission, rows]);
}

export function useTenant(): TenantView {
  const permdock = usePermDock();
  return {
    tenant: permdock.subject.principal?.tenant ?? null,
    tenants: permdock.tenants(),
    switchTo: (id: string) => permdock.refresh({ tenant: id }),
    status: permdock.status(),
  };
}

export function useMemberships(): readonly Membership[] {
  return usePermDock().memberships();
}

export function useRoles(options: UseRolesOptions = {}): {
  readonly roles: readonly Role[];
} {
  const permdock = usePermDock();
  const scoped =
    options.team === undefined ? permdock : permdock.team(options.team);
  return {
    roles: scoped.heldRoles(
      options.tenant === undefined ? undefined : { tenant: options.tenant },
    ),
  };
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
  const permdock = usePermDock();
  const snapshot = permdock.snapshot();
  const simulated =
    typeof snapshot === "object" &&
    snapshot !== null &&
    "simulated" in snapshot &&
    snapshot.simulated === true;
  return {
    principal: permdock.subject.principal,
    actor: permdock.subject.actor,
    delegation: permdock.subject.delegation,
    expiresAt: permdock.subject.expiresAt,
    simulated,
  };
}

export function useApproval(decision: Decision): ApprovalHandle {
  const store = useStore();
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
  const state: ApprovalState = store.approvalState(decision);
  return {
    state,
    token:
      decision.outcome === "approval-required" ? decision.token : undefined,
    request: (note?: string) => store.requestApproval(decision, note),
  };
}
