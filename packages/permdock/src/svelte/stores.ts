import type { Readable } from "svelte/store";

import { derived, readable, toStore, writable } from "svelte/store";

import type { ProtectedActionState } from "../client/protected-action.ts";
import type { ClientStore } from "../client/store.ts";
import type { ProtectedAction } from "../core/action-result.ts";
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
  GateMode,
  GateView,
  SveltePermDockOptions,
  PermissionSet,
  PermissionState,
  ProtectedActionReadable,
  ProtectedActionView,
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
import { getStore, getUi, providePermDock } from "./context.ts";

// Recomputes on a store change and, in the browser build, when a rune read
// inside `compute` (a `data`, `rows` or `options` getter) changes.
function fromStore<T>(store: ClientStore, compute: () => T): Readable<T> {
  return readable(compute(), (set) => {
    const offStore = store.subscribe(() => {
      set(compute());
    });
    const offRunes = toStore(compute).subscribe(set);
    return (): void => {
      offStore();
      offRunes();
    };
  });
}

export function sveltePermDock(store: ClientStore): ClientPermDock {
  return livePermDock(() => store.get());
}

export function setPermDock(options: SveltePermDockOptions): ClientPermDock {
  return sveltePermDock(providePermDock(options));
}

export function getPermDock<
  V extends PolicyVocabulary = PolicyVocabulary,
>(): ClientPermDock<V> {
  // SAFETY: V only types the vocabulary; the store holds the instance for the provider's policy.
  return sveltePermDock(getStore()) as ClientPermDock<V>;
}

/**
 * `describe` with the provider's `messages`; a call's own `messages` win. Call
 * it during component init.
 */
export function getDescribe(): (
  decision: Decision,
  options?: DescribeOptions,
) => DecisionDescription {
  return describeWith(getUi().messages);
}

export function permission<D>(
  reference: Permission,
  data?: () => UncheckedData<D>,
): Readable<PermissionState>;
export function permission<P extends Permission>(
  reference: P,
  data?: () => RowData<P>,
): Readable<PermissionState>;
export function permission(
  reference: Permission,
  data?: () => unknown,
): Readable<PermissionState> {
  return permissionFor(getStore(), reference, data);
}

export function permissionFor(
  store: ClientStore,
  reference: Permission,
  data?: () => unknown,
): Readable<PermissionState> {
  return fromStore(store, () => store.permissionState(reference, data?.()));
}

/**
 * What a permission-gated control renders, as `useGate` in React: `hidden`,
 * `disabled`, `needsApproval`, `upgrade` and a `reason` in the provider's
 * `messages`. Call it during component initialisation.
 */
export function gate<D>(
  reference: Permission,
  data?: () => UncheckedData<D>,
  options?: { readonly mode?: GateMode },
): Readable<GateView>;
export function gate<P extends Permission>(
  reference: P,
  data?: () => RowData<P>,
  options?: { readonly mode?: GateMode },
): Readable<GateView>;
export function gate(
  reference: Permission,
  data?: () => unknown,
  options: { readonly mode?: GateMode } = {},
): Readable<GateView> {
  return gateFor(getStore(), reference, data, {
    ...options,
    describe: getDescribe(),
  });
}

export function gateFor(
  store: ClientStore,
  reference: Permission,
  data?: () => unknown,
  options: {
    readonly mode?: GateMode;
    readonly describe?: (
      decision: Decision,
      options?: DescribeOptions,
    ) => DecisionDescription;
  } = {},
): Readable<GateView> {
  const describeDecision = options.describe ?? describeWith(undefined);
  return fromStore(store, () =>
    gateView(
      store.permissionState(reference, data?.()),
      (decision) => describeDecision(decision, { permission: reference }),
      options.mode,
    ),
  );
}

export function permissions(
  references: () => readonly Permission[],
  data?: () => unknown,
): Readable<PermissionSet> {
  return permissionsFor(getStore(), references, data);
}

export function permissionsFor(
  store: ClientStore,
  references: () => readonly Permission[],
  data?: () => unknown,
): Readable<PermissionSet> {
  return fromStore(store, () => permissionSet(store, references(), data?.()));
}

export function filtered<T>(
  reference: Permission<string, NoInfer<T>, "instance">,
  rows: () => readonly T[],
): Readable<FilterResult<T>> {
  return filteredFor(getStore(), reference, rows);
}

export function filteredFor<T>(
  store: ClientStore,
  reference: Permission<string, NoInfer<T>, "instance">,
  rows: () => readonly T[],
): Readable<FilterResult<T>> {
  return fromStore(store, () => filterResult(store.get(), reference, rows()));
}

export function tenant(): Readable<TenantView> {
  return tenantFor(getStore());
}

export function tenantFor(store: ClientStore): Readable<TenantView> {
  return fromStore(store, () => tenantView(store.get()));
}

export function memberships(): Readable<readonly Membership[]> {
  return membershipsFor(getStore());
}

export function membershipsFor(
  store: ClientStore,
): Readable<readonly Membership[]> {
  return fromStore(store, () => store.get().memberships());
}

export function roles(
  options: () => RolesOptions = () => ({}),
): Readable<{ readonly roles: readonly Role[] }> {
  return rolesFor(getStore(), options);
}

export function rolesFor(
  store: ClientStore,
  options: () => RolesOptions = () => ({}),
): Readable<{ readonly roles: readonly Role[] }> {
  return fromStore(store, () => rolesView(store.get(), options()));
}

export function assignable(): Readable<readonly Role[]> {
  return assignableFor(getStore());
}

export function assignableFor(store: ClientStore): Readable<readonly Role[]> {
  return fromStore(store, () => store.get().assignableRoles());
}

type AssignableOptions =
  | { readonly tenant?: string }
  | (() => { readonly tenant?: string });

export function assignablePermissions(
  options: AssignableOptions = {},
): Readable<readonly Permission[]> {
  return assignablePermissionsFor(getStore(), options);
}

export function assignablePermissionsFor(
  store: ClientStore,
  options: AssignableOptions = {},
): Readable<readonly Permission[]> {
  return fromStore(store, () =>
    store
      .get()
      .assignablePermissions(
        typeof options === "function" ? options() : options,
      ),
  );
}

export function subject(): Readable<SubjectView> {
  return subjectFor(getStore());
}

export function subjectFor(store: ClientStore): Readable<SubjectView> {
  return fromStore(store, () => subjectView(store.get()));
}

export function approval(decision: () => Decision): Readable<ApprovalHandle> {
  return approvalFor(getStore(), decision);
}

export function approvalFor(
  store: ClientStore,
  decision: () => Decision,
): Readable<ApprovalHandle> {
  return fromStore(store, () => approvalHandle(store, decision()));
}

/**
 * A `protectAction` server action wired to a control, as `useProtectedAction`
 * in React: a readable store of `gate`, `result`, `pending` and `approval`,
 * with `run` and `retry`. Call it during component initialisation.
 */
export function protectedAction<T, D>(
  action: ProtectedAction<T>,
  reference: Permission,
  data?: () => UncheckedData<D>,
  options?: { readonly mode?: GateMode },
): ProtectedActionReadable<T>;
export function protectedAction<T, P extends Permission>(
  action: ProtectedAction<T>,
  reference: P,
  data?: () => RowData<P>,
  options?: { readonly mode?: GateMode },
): ProtectedActionReadable<T>;
export function protectedAction<T>(
  action: ProtectedAction<T>,
  reference: Permission,
  data?: () => unknown,
  options: { readonly mode?: GateMode } = {},
): ProtectedActionReadable<T> {
  return protectedActionFor(getStore(), action, reference, data, {
    ...options,
    describe: getDescribe(),
  });
}

export function protectedActionFor<T>(
  store: ClientStore,
  action: ProtectedAction<T>,
  reference: Permission,
  data?: () => unknown,
  options: {
    readonly mode?: GateMode;
    readonly describe?: (
      decision: Decision,
      options?: DescribeOptions,
    ) => DecisionDescription;
  } = {},
): ProtectedActionReadable<T> {
  const state = writable<ProtectedActionState<T>>({
    result: undefined,
    pending: false,
  });
  const runner = actionRunner(() => action, state.set);
  const view = derived(
    [gateFor(store, reference, data, options), state],
    ([gated, current]): ProtectedActionView<T> => ({
      gate: gated,
      result: current.result,
      pending: current.pending,
      approval: actionApproval(store, current.result),
    }),
  );
  return { subscribe: view.subscribe, run: runner.run, retry: runner.retry };
}
