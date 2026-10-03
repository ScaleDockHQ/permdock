import { readable, toStore, type Readable } from "svelte/store";

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
import type { PermDockSvelteOptions } from "./types.ts";

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
  return fromStore(store, () => {
    const granted: Permission[] = [];
    const byKey: Record<string, PermissionState> = {};
    for (const reference of references()) {
      const next = store.permissionState(reference, data?.());
      byKey[reference.key] = next;
      if (next.allowed) {
        granted.push(reference);
      }
    }
    const base: PermissionSet = {
      granted,
      get(reference: Permission): PermissionState | undefined {
        return byKey[reference.key];
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
  return fromStore(store, () => {
    const permdock = store.get();
    // SAFETY: filter returns a fresh array; the next line sets partial on it.
    const next = permdock.filter(reference, rows()) as T[] & {
      partial: boolean;
    };
    next.partial = permdock.where(reference).partial;
    return next;
  });
}

export function tenant(): Readable<TenantView> {
  return tenantFor(getStore());
}

export function tenantFor(store: ClientStore): Readable<TenantView> {
  return fromStore(store, () => {
    const permdock = store.get();
    return {
      tenant: permdock.subject.principal?.tenant ?? null,
      tenants: permdock.tenants(),
      switchTo: (id: string) => permdock.refresh({ tenant: id }),
      status: permdock.status(),
    };
  });
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
  return fromStore(store, () => {
    const next = options();
    const permdock = store.get();
    const scoped =
      next.team === undefined ? permdock : permdock.team(next.team);
    return {
      roles: scoped.heldRoles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function assignable(): Readable<readonly Role[]> {
  return assignableFor(getStore());
}

export function assignableFor(store: ClientStore): Readable<readonly Role[]> {
  return fromStore(store, () => store.get().assignableRoles());
}

export function assignablePermissions(
  options: { readonly tenant?: string } = {},
): Readable<readonly Permission[]> {
  return assignablePermissionsFor(getStore(), options);
}

export function assignablePermissionsFor(
  store: ClientStore,
  options: { readonly tenant?: string } = {},
): Readable<readonly Permission[]> {
  return fromStore(store, () => store.get().assignablePermissions(options));
}

export function subject(): Readable<SubjectView> {
  return subjectFor(getStore());
}

export function subjectFor(store: ClientStore): Readable<SubjectView> {
  return fromStore(store, () => {
    const permdock = store.get();
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

export function approval(decision: () => Decision): Readable<ApprovalHandle> {
  return approvalFor(getStore(), decision);
}

export function approvalFor(
  store: ClientStore,
  decision: () => Decision,
): Readable<ApprovalHandle> {
  return fromStore(store, () => {
    const next = decision();
    const state: ApprovalState = store.approvalState(next);
    return {
      state,
      token: next.outcome === "approval-required" ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
