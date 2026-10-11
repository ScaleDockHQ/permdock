import type { AuthEvent, RoleSource, RoleSourceFactory } from "./interfaces.ts";
import type { CustomRole, Subject } from "./subject.ts";

import { isCustomRoleName } from "./custom-roles.ts";
import { isThenable } from "./thenable.ts";

function isGlobalRole(value: unknown): value is CustomRole {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "scope") === "global"
  );
}

function onlyGlobal(roles: unknown): CustomRole[] {
  return Array.isArray(roles) ? roles.filter(isGlobalRole) : [];
}

/** The `customRoles` option as a source: a factory is called with the resolved subject, and a throw reads none. */
export function roleSourceFor(
  option: RoleSource | RoleSourceFactory | undefined,
  subject: Subject,
  auth: AuthEvent[],
): RoleSource | undefined {
  if (typeof option !== "function") {
    return option;
  }
  try {
    return option(subject);
  } catch {
    auth.push({ reason: "source-threw", source: "customRoles" });
    return undefined;
  }
}

export function customRolesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
  globalHeld: readonly string[] | undefined,
  heldIn: (tenant: string) => readonly string[],
): CustomRole[] | Promise<CustomRole[]> {
  if (source === undefined) {
    return [];
  }
  const loaded: (CustomRole[] | Promise<CustomRole[]>)[] = [];
  for (const tenant of tenants) {
    try {
      loaded.push(source.rolesFor(tenant, { held: heldIn(tenant) }));
    } catch {
      auth.push({ reason: "source-threw", source: "customRoles" });
      loaded.push([]);
    }
  }
  if (globalHeld !== undefined && source.globalRoles !== undefined) {
    try {
      const roles = source.globalRoles({ held: globalHeld });
      loaded.push(
        isThenable(roles) ? roles.then(onlyGlobal) : onlyGlobal(roles),
      );
    } catch {
      auth.push({ reason: "source-threw", source: "customRoles" });
      loaded.push([]);
    }
  }
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) =>
        Promise.resolve(item).catch((): CustomRole[] => {
          auth.push({ reason: "source-threw", source: "customRoles" });
          return [];
        }),
      ),
    ).then((lists) => lists.flat());
  }
  // SAFETY: the branch above returns when any item is a thenable, so every item is a list.
  return (loaded as CustomRole[][]).flat();
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * `RoleSource.assignable` per tenant; `undefined` when the source has no
 * `assignable`. A tenant whose call throws or answers junk assigns nothing.
 */
export function assignableNamesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
):
  | ReadonlyMap<string, readonly string[]>
  | Promise<ReadonlyMap<string, readonly string[]>>
  | undefined {
  if (source?.assignable === undefined) {
    return undefined;
  }
  const failed = (): string[] => {
    auth.push({ reason: "source-threw", source: "customRoles" });
    return [];
  };
  const loaded = tenants.map((tenant) => {
    try {
      return source.assignable?.(tenant) ?? [];
    } catch {
      return failed();
    }
  });
  const toMap = (lists: readonly unknown[]): Map<string, readonly string[]> =>
    new Map(tenants.map((tenant, index) => [tenant, stringList(lists[index])]));
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) => Promise.resolve(item).catch(failed)),
    ).then(toMap);
  }
  return toMap(loaded);
}

/**
 * The declared role names among `names`. A custom role of `tenant` is known
 * but contributes no declared name: its grants are resolved separately
 * (`customGrantsFor`), bounded by the ceiling. A tenant's custom role is
 * unknown inside another tenant and for a membership without one.
 */
export function expandRoleNames(
  names: readonly string[],
  declared: ReadonlySet<string>,
  custom: readonly CustomRole[],
  tenant: string | undefined,
): { readonly roles: readonly string[]; readonly unknown: readonly string[] } {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    if (declared.has(name)) {
      resolved.add(name);
    } else if (!isCustomRoleName(name, custom, tenant)) {
      unknown.push(name);
    }
  }
  return { roles: [...resolved], unknown };
}
