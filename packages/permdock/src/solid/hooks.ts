import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { Membership } from "../core/subject.ts";
import type { Role } from "../core/vocabulary.ts";
import type { ClientStore } from "../react/store.ts";
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

import { useStore } from "./context.ts";

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
  // SAFETY: the empty target is never read; the get trap answers from the store's current instance.
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
      typeof permission === "function" ? permission() : permission;
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
        if (typeof prop === "string" && Object.hasOwn(byKey, prop)) {
          return byKey[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
}

export function useFilter<T>(
  permission: Permission<string, T, "instance">,
  rows: Accessor<readonly T[]>,
): Accessor<FilterResult<T>> {
  const permdock = usePermDock();
  return createMemo(() => {
    // SAFETY: filter returns a fresh array; the next line sets partial on it.
    const next = permdock.filter(permission, rows()) as T[] & {
      partial: boolean;
    };
    next.partial = permdock.where(permission).partial;
    return next;
  });
}

export function useTenant(): Accessor<TenantView> {
  const permdock = usePermDock();
  return createMemo(() => ({
    tenant: permdock.subject.principal?.tenant ?? null,
    tenants: permdock.tenants(),
    switchTo: (id: string) => permdock.refresh({ tenant: id }),
    status: permdock.status(),
  }));
}

export function useMemberships(): Accessor<readonly Membership[]> {
  const permdock = usePermDock();
  return createMemo(() => permdock.memberships());
}

export function useRoles(
  options: Accessor<UseRolesOptions> = () => ({}),
): Accessor<{ readonly roles: readonly Role[] }> {
  const permdock = usePermDock();
  return createMemo(() => {
    const next = options();
    const scoped =
      next.team === undefined ? permdock : permdock.team(next.team);
    return {
      roles: scoped.heldRoles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function useAssignableRoles(): Accessor<readonly Role[]> {
  const permdock = usePermDock();
  return createMemo(() => permdock.assignableRoles());
}

export function useAssignablePermissions(
  options: { readonly tenant?: string } = {},
): Accessor<readonly Permission[]> {
  const permdock = usePermDock();
  return createMemo(() => permdock.assignablePermissions(options));
}

export function useSubject(): Accessor<SubjectView> {
  const permdock = usePermDock();
  return createMemo(() => {
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
      token: next.outcome === "approval-required" ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
