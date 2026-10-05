import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { Role } from "../core/vocabulary.ts";
import type { ClientStore } from "../react/store.ts";
import type {
  ApprovalHandle,
  ClientPermDock,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from "../react/types.ts";

export function permissionSet(
  store: ClientStore,
  permissions: readonly Permission[],
  data: unknown,
): PermissionSet {
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
}

export function filterResult<T>(
  permdock: ClientPermDock,
  permission: Permission<string, T, "instance">,
  rows: readonly T[],
): FilterResult<T> {
  // SAFETY: filter returns a fresh array; the next line sets partial on it.
  const result = permdock.filter(permission, rows) as T[] & {
    partial: boolean;
  };
  result.partial = permdock.where(permission).partial;
  return result;
}

export function tenantView(permdock: ClientPermDock): TenantView {
  return {
    tenant: permdock.subject.principal?.tenant ?? null,
    tenants: permdock.tenants(),
    switchTo: (id: string) => permdock.refresh({ tenant: id }),
    status: permdock.status(),
  };
}

export function rolesView(
  permdock: ClientPermDock,
  options: UseRolesOptions,
): { readonly roles: readonly Role[] } {
  const scoped =
    options.team === undefined ? permdock : permdock.team(options.team);
  return {
    roles: scoped.heldRoles(
      options.tenant === undefined ? undefined : { tenant: options.tenant },
    ),
  };
}

export function subjectView(permdock: ClientPermDock): SubjectView {
  const snapshot = permdock.snapshot();
  return {
    principal: permdock.subject.principal,
    actor: permdock.subject.actor,
    delegation: permdock.subject.delegation,
    expiresAt: permdock.subject.expiresAt,
    simulated:
      typeof snapshot === "object" &&
      snapshot !== null &&
      "simulated" in snapshot &&
      snapshot.simulated === true,
  };
}

export function approvalHandle(
  store: ClientStore,
  decision: Decision,
): ApprovalHandle {
  return {
    state: store.approvalState(decision),
    token:
      decision.outcome === "approval-required" ? decision.token : undefined,
    request: (note?: string) => store.requestApproval(decision, note),
  };
}
