import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";

import { freezeDeep } from "./freeze.ts";
import { listPermissions } from "./permission-registry.ts";

export type SeedRole = {
  readonly key: string;
  readonly scope: string;
  readonly system?: boolean;
  /** Permission references. Strings are not accepted. */
  readonly grants: readonly Permission[];
};

export type SeedFixtures = {
  readonly users?: Readonly<
    Record<string, { readonly id: string; readonly email?: string }>
  >;
  readonly tenants?: Readonly<Record<string, { readonly id: string }>>;
  readonly memberships?: readonly {
    readonly user: string;
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
  readonly customRoles?: readonly {
    readonly tenant: string;
    readonly key: string;
    readonly grants: readonly Permission[];
  }[];
  readonly rows?: Readonly<
    Record<string, readonly Readonly<Record<string, string>>[]>
  >;
};

export type SeedInput = {
  readonly defaults?: { readonly roles?: readonly SeedRole[] };
  readonly fixtures?: SeedFixtures;
};

export type FrozenSeedRole = {
  readonly key: string;
  readonly scope: string;
  readonly system?: boolean;
  readonly grants: readonly string[];
};

/** Frozen seed data. Grants are permission keys. */
export type Seeds = {
  readonly defaults: { readonly roles: readonly FrozenSeedRole[] };
  readonly fixtures: {
    readonly users: Readonly<
      Record<string, { readonly id: string; readonly email?: string }>
    >;
    readonly tenants: Readonly<Record<string, { readonly id: string }>>;
    readonly memberships: readonly {
      readonly user: string;
      readonly tenant: string;
      readonly roles: readonly string[];
    }[];
    readonly customRoles: readonly {
      readonly tenant: string;
      readonly key: string;
      readonly grants: readonly string[];
    }[];
    readonly rows: Readonly<
      Record<string, readonly Readonly<Record<string, string>>[]>
    >;
  };
};

function roleOf(role: SeedRole): FrozenSeedRole {
  return {
    key: role.key,
    scope: role.scope,
    ...(role.system === undefined ? {} : { system: role.system }),
    grants: role.grants.map((grant) => grant.key),
  };
}

/**
 * Typed seed data for `policy`. Defaults apply in every environment. Fixtures
 * are for dev and test. An unknown role, scope or permission throws.
 */
export function defineSeeds(policy: Policy, input: SeedInput = {}): Seeds {
  const permissions = new Set(
    listPermissions(policy.permissions).map((leaf) => leaf.key),
  );
  const roles = new Set(policy.roles.map((role) => role.name));
  const scopes = new Set(policy.scopes.map((scope) => scope.name));
  const check = (
    label: string,
    scope: string,
    grants: readonly Permission[],
  ): void => {
    if (scope !== "global" && !scopes.has(scope)) {
      throw new Error(`PermDock: ${label} names unknown scope '${scope}'`);
    }
    for (const grant of grants) {
      if (!permissions.has(grant.key)) {
        throw new Error(
          `PermDock: ${label} names unknown permission '${grant.key}'`,
        );
      }
    }
  };
  for (const role of input.defaults?.roles ?? []) {
    if (!roles.has(role.key)) {
      throw new Error(`PermDock: default names unknown role '${role.key}'`);
    }
    check(`role ${role.key}`, role.scope, role.grants);
  }
  for (const role of input.fixtures?.customRoles ?? []) {
    for (const grant of role.grants) {
      if (!permissions.has(grant.key)) {
        throw new Error(
          `PermDock: custom role ${role.key} names unknown permission '${grant.key}'`,
        );
      }
    }
  }
  const fixtures = input.fixtures;
  return freezeDeep({
    defaults: { roles: (input.defaults?.roles ?? []).map(roleOf) },
    fixtures: {
      users: fixtures?.users ?? {},
      tenants: fixtures?.tenants ?? {},
      memberships: fixtures?.memberships ?? [],
      customRoles: (fixtures?.customRoles ?? []).map((role) => ({
        tenant: role.tenant,
        key: role.key,
        grants: role.grants.map((grant) => grant.key),
      })),
      rows: fixtures?.rows ?? {},
    },
  });
}
