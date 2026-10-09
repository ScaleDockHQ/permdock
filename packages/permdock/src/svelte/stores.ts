import { readable, toStore, type Readable } from "svelte/store";

import type { ClientStore } from "../client/store.ts";
import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
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
  UseRolesOptions,
} from "./types.ts";
import type { PermDockSvelteOptions } from "./types.ts";

import {
  approvalHandle,
  filterResult,
  permissionSet,
  rolesView,
  subjectView,
  tenantView,
} from "../client/views.ts";
import { getStore, providePermDock } from "./context.ts";

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
  // SAFETY: the empty target is never read; the get trap answers from the store's current instance.
  return new Proxy({} as ClientPermDock, {
    get(_target, prop, _receiver): unknown {
      return Reflect.get(store.get(), prop);
    },
  });
}

export function setPermDock(options: PermDockSvelteOptions): ClientPermDock {
  return sveltePermDock(providePermDock(options));
}

export function getPermDock(): ClientPermDock {
  return sveltePermDock(getStore());
}

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
  reference: Permission<string, T, "instance">,
  rows: () => readonly T[],
): Readable<FilterResult<T>> {
  return filteredFor(getStore(), reference, rows);
}

export function filteredFor<T>(
  store: ClientStore,
  reference: Permission<string, T, "instance">,
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
  options: () => UseRolesOptions = () => ({}),
): Readable<{ readonly roles: readonly Role[] }> {
  return rolesFor(getStore(), options);
}

export function rolesFor(
  store: ClientStore,
  options: () => UseRolesOptions = () => ({}),
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
