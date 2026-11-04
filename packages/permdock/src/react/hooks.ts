import { use, useEffect, useMemo, useSyncExternalStore } from "react";

import type { RefreshTrigger } from "../client/refresh-on.ts";
import type { ClientStore } from "../client/store.ts";
import type { GateMode, GateView } from "../client/types.ts";
import type { Decision } from "../core/decision.ts";
import type { DecisionDescription, DescribeOptions } from "../core/describe.ts";
import type { RowData, UncheckedData } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { Membership } from "../core/subject.ts";
import type { Role } from "../core/vocabulary.ts";
import type {
  ApprovalHandle,
  ClientPermDock,
  FilterResult,
  PermissionOutcome,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  RolesOptions,
} from "./types.ts";

import {
  storeOf,
  approvalHandle,
  describeWith,
  filterResult,
  gateView,
  permissionSet,
  rolesView,
  subjectView,
  tenantView,
} from "../client/kit.ts";
import {
  PermDockSnapshotPromiseContext,
  PermDockStoreContext,
  PermDockUiContext,
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

/**
 * The store's current instance without the evaluator: memberships, tenants,
 * roles and the subject read from the snapshot, every check denies until
 * `usePermDock` loads the evaluator.
 */
export function useSnapshotPermDock(): ClientPermDock {
  const store = useStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.serverGet(),
  );
}

/** Suspends the nearest boundary until the store's evaluator has loaded. */
function useEvaluator(store: ClientStore, needed = true): void {
  const loading = needed ? store.loading() : undefined;
  if (loading !== undefined) {
    use(loading);
  }
}

/**
 * The instance with every check. It loads the evaluator on first use and
 * suspends the nearest boundary while it does.
 */
export function usePermDock<
  V extends PolicyVocabulary = PolicyVocabulary,
>(): ClientPermDock<V> {
  const permdock = useSnapshotPermDock();
  useEvaluator(storeOf(permdock));
  // SAFETY: V only types the vocabulary; the store holds the instance for the provider's policy.
  return permdock as ClientPermDock<V>;
}

/**
 * Adds refresh triggers to the nearest provider while the component is mounted.
 * Use it where the provider's own `refreshOn` cannot be set, such as below
 * `permdock/next`'s Server Component provider: functions cannot cross to the
 * client. Keep `triggers` stable (module scope); a new array resubscribes.
 */
export function useRefreshOn(triggers: readonly RefreshTrigger[]): void {
  const store = useStore();
  useEffect(() => store.refreshOn(triggers), [store, triggers]);
}

// The hooks reach the store through `permdock`: the React Compiler keeps only
// the dependencies a memoised callback reads, and `permdock` is the one that
// changes when the store does.
export function usePermission(permission: Permission): PermissionOutcome;
export function usePermission<D>(
  permission: Permission,
  data: UncheckedData<D>,
): PermissionState;
export function usePermission<P extends Permission>(
  permission: P,
  data: RowData<P>,
): PermissionState;
export function usePermission(
  permission: Permission,
  data?: unknown,
): PermissionOutcome | PermissionState {
  const permdock = useSnapshotPermDock();
  const store = storeOf(permdock);
  useEvaluator(
    store,
    data !== undefined || store.quick(permission) === undefined,
  );
  // The compiler keeps only the dependencies the callback reads: `permdock` is the one that changes when the store does.
  return useMemo(() => {
    const current = storeOf(permdock);
    if (data !== undefined) {
      return current.permissionState(permission, data);
    }
    const quick = current.quick(permission);
    if (quick !== undefined) {
      return quick;
    }
    const { allowed, status, decision } = current.permissionState(permission);
    return { allowed, status, outcome: decision.outcome };
  }, [permdock, permission, data]);
}

/**
 * The check with its `Decision`: denial reasons, alternatives and the approval
 * token. Loads the evaluator on first use; `usePermission(permission)` does
 * not.
 */
export function useDecision<D>(
  permission: Permission,
  data?: UncheckedData<D>,
): PermissionState;
export function useDecision<P extends Permission>(
  permission: P,
  data?: RowData<P>,
): PermissionState;
export function useDecision(
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
  permission: Permission<string, NoInfer<T>, "instance">,
  rows: readonly T[],
): FilterResult<T> {
  const permdock = usePermDock();
  return useMemo(
    () => filterResult(permdock, permission, rows),
    [permdock, permission, rows],
  );
}

export function useTenant(): TenantView {
  const permdock = useSnapshotPermDock();
  return useMemo(() => tenantView(permdock), [permdock]);
}

export function useMemberships(): readonly Membership[] {
  const permdock = useSnapshotPermDock();
  return useMemo(() => permdock.memberships(), [permdock]);
}

export function useRoles(options: RolesOptions = {}): {
  readonly roles: readonly Role[];
} {
  const permdock = useSnapshotPermDock();
  const { tenant, scope, id } = options;
  return useMemo(
    () =>
      rolesView(permdock, {
        ...(tenant === undefined ? {} : { tenant }),
        ...(scope === undefined ? {} : { scope }),
        ...(id === undefined ? {} : { id }),
      }),
    [permdock, tenant, scope, id],
  );
}

export function useAssignableRoles(): readonly Role[] {
  const permdock = useSnapshotPermDock();
  return useMemo(() => permdock.assignableRoles(), [permdock]);
}

export function useAssignablePermissions(
  options: { readonly tenant?: string } = {},
): readonly Permission[] {
  const permdock = useSnapshotPermDock();
  const { tenant } = options;
  return useMemo(
    () =>
      permdock.assignablePermissions(tenant === undefined ? {} : { tenant }),
    [permdock, tenant],
  );
}

export function useSubject(): SubjectView {
  const permdock = useSnapshotPermDock();
  return useMemo(() => subjectView(permdock), [permdock]);
}

/** `describe` with the provider's `messages`; a call's own `messages` win. */
export function useDescribe(): (
  decision: Decision,
  options?: DescribeOptions,
) => DecisionDescription {
  const { messages } = use(PermDockUiContext);
  return useMemo(() => describeWith(messages), [messages]);
}

export function useApproval(decision: Decision): ApprovalHandle {
  return approvalHandle(storeOf(useSnapshotPermDock()), decision);
}

/**
 * What a permission-gated control renders: `hidden`, `disabled`,
 * `needsApproval`, `upgrade` and a localised `reason`, from the same snapshot
 * as `usePermission`. React and React Native share it; a recipe renders the
 * fields and decides nothing.
 */
export function useGate<D>(
  permission: Permission,
  data?: UncheckedData<D>,
  options?: { readonly mode?: GateMode },
): GateView;
export function useGate<P extends Permission>(
  permission: P,
  data?: RowData<P>,
  options?: { readonly mode?: GateMode },
): GateView;
export function useGate(
  permission: Permission,
  data?: unknown,
  options: { readonly mode?: GateMode } = {},
): GateView {
  const state = useDecision(permission, data);
  const describeDecision = useDescribe();
  const mode = options.mode ?? "disable";
  return useMemo(
    () =>
      gateView(
        state,
        (decision) => describeDecision(decision, { permission }),
        mode,
      ),
    [state, describeDecision, permission, mode],
  );
}
