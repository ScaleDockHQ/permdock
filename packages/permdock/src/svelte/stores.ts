import { readable, type Readable } from 'svelte/store';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Membership } from '../core/subject.ts';
import type { ClientStore } from '../react/store.ts';
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
} from './types.ts';
import type { PermDockSvelteOptions } from './types.ts';

import { getStore, providePermDock } from './context.ts';

function fromStore<T>(store: ClientStore, compute: () => T): Readable<T> {
  return readable(compute(), (set) =>
    store.subscribe(() => {
      set(compute());
    }),
  );
}

export function sveltePermDock(store: ClientStore): ClientPermDock {
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
        if (typeof prop === 'string' && Object.hasOwn(byKey, prop)) {
          return byKey[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
}

export function filtered<T>(
  reference: Permission<string, T, 'instance'>,
  rows: () => readonly T[],
): Readable<FilterResult<T>> {
  return filteredFor(getStore(), reference, rows);
}

export function filteredFor<T>(
  store: ClientStore,
  reference: Permission<string, T, 'instance'>,
  rows: () => readonly T[],
): Readable<FilterResult<T>> {
  return fromStore(store, () => {
    const dock = store.get();
    const next = dock.filter(reference, rows()) as T[] & { partial: boolean };
    next.partial = dock.where(reference).partial;
    return next;
  });
}

export function tenant(): Readable<TenantView> {
  return tenantFor(getStore());
}

export function tenantFor(store: ClientStore): Readable<TenantView> {
  return fromStore(store, () => {
    const dock = store.get();
    return {
      tenant: dock.subject.principal?.tenant ?? null,
      tenants: dock.tenants(),
      switchTo: (id: string) => dock.refresh({ tenant: id }),
      status: dock.status(),
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
): Readable<{ readonly roles: readonly string[] }> {
  return rolesFor(getStore(), options);
}

export function rolesFor(
  store: ClientStore,
  options: () => UseRolesOptions = () => ({}),
): Readable<{ readonly roles: readonly string[] }> {
  return fromStore(store, () => {
    const next = options();
    const dock = store.get();
    const scoped = next.team === undefined ? dock : dock.team(next.team);
    return {
      roles: scoped.roles(
        next.tenant === undefined ? undefined : { tenant: next.tenant },
      ),
    };
  });
}

export function assignable(): Readable<readonly string[]> {
  return assignableFor(getStore());
}

export function assignableFor(store: ClientStore): Readable<readonly string[]> {
  return fromStore(store, () => store.get().assignable());
}

export function subject(): Readable<SubjectView> {
  return subjectFor(getStore());
}

export function subjectFor(store: ClientStore): Readable<SubjectView> {
  return fromStore(store, () => {
    const dock = store.get();
    const snapshot = dock.snapshot();
    const simulated =
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'simulated' in snapshot &&
      snapshot.simulated === true;
    return {
      principal: dock.subject.principal,
      actor: dock.subject.actor,
      delegation: dock.subject.delegation,
      expiresAt: dock.subject.expiresAt,
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
    let state: ApprovalState = 'not-needed';
    if (next.outcome === 'approval-required') {
      state = 'required';
    }
    return {
      state,
      token: next.outcome === 'approval-required' ? next.token : undefined,
      request: (note?: string) => store.requestApproval(next, note),
    };
  });
}
