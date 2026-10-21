import type { Accessor } from "solid-js";

import {
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  useContext,
} from "solid-js";

import type { ProtectedActionState } from "../client/protected-action.ts";
import type { ClientStore } from "../client/store.ts";
import type { ProtectedAction } from "../core/action-result.ts";
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
  GateMode,
  GateView,
  PermissionSet,
  PermissionState,
  ProtectedActionAccessors,
  SubjectView,
  TenantView,
  RolesOptions,
} from "./types.ts";

import {
  actionApproval,
  actionRunner,
  approvalHandle,
  describeWith,
  filterResult,
  gateView,
  livePermDock,
  permissionSet,
  rolesView,
  subjectView,
  tenantView,
} from "../client/kit.ts";
import { PermDockUiContext, useStore } from "./context.ts";

function useVersion(store: ClientStore): Accessor<number> {
  if (getOwner() === null) {
    throw new Error(
      "PermDock: call hooks inside a component or createRoot, which removes their store subscription.",
    );
  }
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
  return livePermDock(() => {
    version();
    return store.get();
  });
}

export function usePermission<D>(
  permission: Permission | Accessor<Permission>,
  data?: Accessor<UncheckedData<D>>,
): Accessor<PermissionState>;
export function usePermission<P extends Permission>(
  permission: P | Accessor<P>,
  data?: Accessor<RowData<P>>,
): Accessor<PermissionState>;
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

/**
 * What a permission-gated control renders, as `useGate` in React: `hidden`,
 * `disabled`, `needsApproval`, `upgrade` and a localised `reason`.
 */
export function useGate<D>(
  permission: Permission | Accessor<Permission>,
  data?: Accessor<UncheckedData<D>>,
  options?: { readonly mode?: GateMode },
): Accessor<GateView>;
export function useGate<P extends Permission>(
  permission: P | Accessor<P>,
  data?: Accessor<RowData<P>>,
  options?: { readonly mode?: GateMode },
): Accessor<GateView>;
export function useGate(
  permission: Permission | Accessor<Permission>,
  data?: Accessor<unknown>,
  options: { readonly mode?: GateMode } = {},
): Accessor<GateView> {
  const store = useStore();
  const version = useVersion(store);
  const describeDecision = useDescribe();
  return createMemo(() => {
    version();
    const current =
      typeof permission === "function" ? permission() : permission;
    return gateView(
      store.permissionState(current, data?.()),
      (decision) => describeDecision(decision, { permission: current }),
      options.mode,
    );
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
    return permissionSet(store, permissions(), data?.());
  });
}

export function useFilter<T>(
  permission: Permission<string, NoInfer<T>, "instance">,
  rows: Accessor<readonly T[]>,
): Accessor<FilterResult<T>> {
  const permdock = usePermDock();
  return createMemo(() => filterResult(permdock, permission, rows()));
}

export function useTenant(): Accessor<TenantView> {
  const permdock = usePermDock();
  return createMemo(() => tenantView(permdock));
}

export function useMemberships(): Accessor<readonly Membership[]> {
  const permdock = usePermDock();
  return createMemo(() => permdock.memberships());
}

export function useRoles(
  options: Accessor<RolesOptions> = () => ({}),
): Accessor<{ readonly roles: readonly Role[] }> {
  const permdock = usePermDock();
  return createMemo(() => rolesView(permdock, options()));
}

export function useAssignableRoles(): Accessor<readonly Role[]> {
  const permdock = usePermDock();
  return createMemo(() => permdock.assignableRoles());
}

export function useAssignablePermissions(
  options:
    | { readonly tenant?: string }
    | Accessor<{ readonly tenant?: string }> = {},
): Accessor<readonly Permission[]> {
  const permdock = usePermDock();
  return createMemo(() =>
    permdock.assignablePermissions(
      typeof options === "function" ? options() : options,
    ),
  );
}

export function useSubject(): Accessor<SubjectView> {
  const permdock = usePermDock();
  return createMemo(() => subjectView(permdock));
}

export function useApproval(
  decision: Accessor<Decision>,
): Accessor<ApprovalHandle> {
  const store = useStore();
  const version = useVersion(store);
  return createMemo(() => {
    version();
    return approvalHandle(store, decision());
  });
}

/** `describe` with the provider's `messages`; a call's own `messages` win. */
export function useDescribe(): (
  decision: Decision,
  options?: DescribeOptions,
) => DecisionDescription {
  const ui = useContext(PermDockUiContext);
  return (decision, options) => describeWith(ui.messages)(decision, options);
}

/**
 * A `protectAction` server action wired to a control, as `useProtectedAction`
 * in React: accessors for `gate`, `result`, `pending` and `approval`, plus
 * `run` and `retry`.
 */
export function useProtectedAction<T, D>(
  action: ProtectedAction<T>,
  permission: Permission | Accessor<Permission>,
  data?: Accessor<UncheckedData<D>>,
  options?: { readonly mode?: GateMode },
): ProtectedActionAccessors<T>;
export function useProtectedAction<T, P extends Permission>(
  action: ProtectedAction<T>,
  permission: P | Accessor<P>,
  data?: Accessor<RowData<P>>,
  options?: { readonly mode?: GateMode },
): ProtectedActionAccessors<T>;
export function useProtectedAction<T>(
  action: ProtectedAction<T>,
  permission: Permission | Accessor<Permission>,
  data?: Accessor<unknown>,
  options: { readonly mode?: GateMode } = {},
): ProtectedActionAccessors<T> {
  const store = useStore();
  const version = useVersion(store);
  const gate = useGate(permission, data, options);
  const [state, setState] = createSignal<ProtectedActionState<T>>({
    result: undefined,
    pending: false,
  });
  const runner = actionRunner(
    () => action,
    (next) => {
      setState(next);
    },
  );
  const approval = createMemo(() => {
    version();
    return actionApproval(store, state().result);
  });
  return {
    gate,
    result: () => state().result,
    pending: () => state().pending,
    approval,
    run: runner.run,
    retry: runner.retry,
  };
}
