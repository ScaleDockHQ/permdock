import type {
  EntitlementSource,
  MemberEntry,
  MembershipSource,
  CustomRoleSource,
  SettingsSource,
  SnapshotSource,
  TenantSettings,
} from "./interfaces.ts";
import type { Snapshot } from "./snapshot-types.ts";
import type { CustomRole, Membership } from "./subject.ts";

export function memoryEntitlementSource(
  entries: Readonly<Record<string, readonly string[]>>,
): EntitlementSource {
  return {
    entitlementsFor(_principal, options) {
      return options.tenant === undefined
        ? []
        : [...(entries[options.tenant] ?? [])];
    },
  };
}

export function memorySettingsSource(
  settings: Readonly<Record<string, TenantSettings>>,
): SettingsSource {
  const byTenant = new Map(Object.entries(settings));
  return Object.freeze({
    settingsFor(tenant: string): TenantSettings | undefined {
      return byTenant.get(tenant);
    },
  });
}

/**
 * Memberships keyed by principal id; `tenant` is not a filter, as for a
 * database source.
 */
export function memoryMembershipSource(
  entries: Readonly<Record<string, readonly Membership[]>>,
): MembershipSource {
  const byPrincipal = new Map(Object.entries(entries));
  return Object.freeze({
    membershipsFor(principal: { readonly id: string }): Membership[] {
      return [...(byPrincipal.get(principal.id) ?? [])];
    },
    list(query: {
      readonly scope: string;
      readonly id: string;
    }): MemberEntry[] {
      const members: MemberEntry[] = [];
      for (const [id, memberships] of byPrincipal) {
        for (const membership of memberships) {
          if (membership.scope === query.scope && membership.id === query.id) {
            members.push({ principal: { id }, membership });
          }
        }
      }
      return members;
    },
  });
}

/** A snapshot held in memory; `set` replaces it and notifies every subscriber. */
export function memorySnapshotSource(
  initial: Snapshot | string,
): SnapshotSource & { set(snapshot: Snapshot | string): void } {
  let current = initial;
  const listeners = new Set<() => void>();
  return Object.freeze({
    get: (): Snapshot | string => current,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    set(snapshot: Snapshot | string): void {
      current = snapshot;
      for (const listener of listeners) {
        listener();
      }
    },
  });
}

export function memoryCustomRoleSource(
  customRoles: readonly CustomRole[],
): CustomRoleSource {
  const byTenant = new Map<string, CustomRole[]>();
  const global: CustomRole[] = [];
  const shared: CustomRole[] = [];
  for (const role of customRoles) {
    if (role.shared === true) {
      shared.push(role);
      continue;
    }
    if (role.tenant === undefined) {
      global.push(role);
      continue;
    }
    const list = byTenant.get(role.tenant) ?? [];
    list.push(role);
    byTenant.set(role.tenant, list);
  }
  return {
    rolesFor(tenant: string): CustomRole[] {
      return [...(byTenant.get(tenant) ?? [])];
    },
    globalRoles(): CustomRole[] {
      return [...global];
    },
    sharedRoles(): CustomRole[] {
      return [...shared];
    },
  };
}
