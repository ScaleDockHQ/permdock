import type { RoleSource } from "./interfaces.ts";
import type { Policy } from "./policy.ts";
import type { CustomRole } from "./subject.ts";

import { declaredRoleNames } from "./policy.ts";
import { isThenable } from "./thenable.ts";

/** Reads custom roles from the application's store, as `customRoleSource` takes them. */
export type CustomRoleReader = {
  /** Every custom role of `tenant`, whether or not anyone in the request holds it. */
  rolesOf(tenant: string): CustomRole[] | Promise<CustomRole[]>;
  assignable?(tenant: string): string[] | Promise<string[]>;
  /** Platform custom roles (`scope: 'global'`). */
  globalRoles?(): CustomRole[] | Promise<CustomRole[]>;
};

export type CustomRoleSourceOptions =
  | {
      /** `'all'` (default): read every custom role of each tenant, so `assignableRoles` and `decideRoleChange` see them all. */
      readonly read?: "all";
    }
  | {
      /** `'held'`: skip a tenant's read, and the platform read, when every role the subject holds there is declared in `policy`. For requests that never manage roles. */
      readonly read: "held";
      readonly policy: Policy;
    };

function ofTenant(tenant: string, roles: unknown): CustomRole[] {
  return Array.isArray(roles)
    ? roles.filter(
        (role: unknown): role is CustomRole =>
          role !== null &&
          typeof role === "object" &&
          Reflect.get(role, "tenant") === tenant,
      )
    : [];
}

/**
 * A `RoleSource` over a reader that returns every custom role of a tenant.
 * It keeps only the roles of the requested tenant. With `read: 'held'` it
 * skips a tenant's read, and `globalRoles`, when the subject holds only
 * declared roles there.
 */
export function customRoleSource(
  reader: CustomRoleReader,
  options: CustomRoleSourceOptions = {},
): RoleSource {
  const declared =
    options.read === "held" ? declaredRoleNames(options.policy) : undefined;
  const source: RoleSource = {
    rolesFor(tenant, context) {
      if (
        declared !== undefined &&
        context?.held.every((name) => declared.has(name)) === true
      ) {
        return [];
      }
      const roles = reader.rolesOf(tenant);
      return isThenable(roles)
        ? roles.then((list) => ofTenant(tenant, list))
        : ofTenant(tenant, roles);
    },
  };
  return Object.freeze({
    ...source,
    ...(reader.assignable === undefined
      ? {}
      : { assignable: (tenant: string) => reader.assignable?.(tenant) ?? [] }),
    ...(reader.globalRoles === undefined
      ? {}
      : {
          globalRoles: (context?: { readonly held: readonly string[] }) =>
            declared !== undefined &&
            context?.held.every((name) => declared.has(name)) === true
              ? []
              : (reader.globalRoles?.() ?? []),
        }),
  });
}
