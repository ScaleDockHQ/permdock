import type { Decision, GrantedDecision } from "../core/decision.ts";
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

type DecidePermDock = {
  readonly decide: (permission: Permission, data?: unknown) => Decision;
};

/** What `Protected` renders: `pending` while an endpoint answer is in flight, `fallback` unless granted. */
export type ProtectedView =
  | (PermissionState & { readonly slot: "pending" | "fallback" })
  | {
      readonly allowed: true;
      readonly status: PermissionState["status"];
      readonly decision: GrantedDecision;
      readonly slot: "default";
    };

/** `local` answers the active tenant; another `tenant` is decided on the spot. */
export function protectedView(
  local: PermissionState,
  root: ClientPermDock,
  permission: Permission,
  data: unknown,
  tenant: string | undefined,
): ProtectedView {
  const state =
    tenant === undefined ? local : decideIn(root, tenant, permission, data);
  if (state.status === "pending") {
    return { ...state, slot: "pending" };
  }
  const decision = state.decision;
  if (!state.allowed || decision.outcome !== "granted") {
    return { ...state, slot: "fallback" };
  }
  return { allowed: true, status: state.status, decision, slot: "default" };
}

function decideIn(
  root: ClientPermDock,
  tenant: string,
  permission: Permission,
  data: unknown,
): PermissionState {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  const scoped = root.tenant(tenant) as DecidePermDock;
  const decision = scoped.decide(permission, data);
  return { allowed: decision.outcome === "granted", status: "ready", decision };
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
