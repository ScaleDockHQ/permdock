import type { CustomRoleSource, MembershipSource } from "../core/interfaces.ts";
import type { Seeds } from "../core/seeds.ts";
import type { CustomRole, Membership } from "../core/subject.ts";

/**
 * One role a fixture user holds, with the permissions that role's defaults
 * grant.
 */
export type RolePersona = {
  readonly name: string;
  readonly user: string;
  readonly tenant: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
};

/**
 * One persona per fixture membership. `user` and `tenant` are the fixture ids.
 * Permissions come from `defaults.roles` for each role the membership holds.
 */
export function rolePersonas(seeds: Seeds): readonly RolePersona[] {
  const grants = new Map(
    seeds.defaults.roles.map((role) => [role.key, role.grants]),
  );
  return seeds.fixtures.memberships.map((membership) => {
    const user = seeds.fixtures.users[membership.user]?.id ?? membership.user;
    const tenant =
      seeds.fixtures.tenants[membership.tenant]?.id ?? membership.tenant;
    return {
      name:
        membership.roles.length === 0
          ? membership.user
          : membership.roles.join("_"),
      user,
      tenant,
      roles: membership.roles,
      permissions: membership.roles.flatMap((role) => grants.get(role) ?? []),
    };
  });
}

function membershipsOf(seeds: Seeds, userId: string): readonly Membership[] {
  return seeds.fixtures.memberships.flatMap((membership) => {
    const user = seeds.fixtures.users[membership.user];
    if (user?.id !== userId && membership.user !== userId) {
      return [];
    }
    const tenant =
      seeds.fixtures.tenants[membership.tenant]?.id ?? membership.tenant;
    return [{ scope: "tenant", id: tenant, roles: membership.roles }];
  });
}

/**
 * Membership, version and custom-role sources that answer from `seeds`, the
 * stand-in for `postgrestSources` when there is no PostgREST client.
 */
export function memoryPostgrestSources(seeds: Seeds): {
  readonly memberships: MembershipSource;
  readonly customRoles: CustomRoleSource;
} {
  const memberships: MembershipSource = {
    name: "memory-postgrest",
    membershipsFor: (principal) => [...membershipsOf(seeds, principal.id)],
    list: (query) =>
      seeds.fixtures.memberships.flatMap((membership) => {
        const tenant =
          seeds.fixtures.tenants[membership.tenant]?.id ?? membership.tenant;
        if (query.scope !== "tenant" || tenant !== query.id) {
          return [];
        }
        const user =
          seeds.fixtures.users[membership.user]?.id ?? membership.user;
        return [
          {
            principal: { id: user },
            membership: {
              scope: "tenant",
              id: tenant,
              roles: membership.roles,
            },
          },
        ];
      }),
    version: () => 1,
  };
  const customRoles: CustomRoleSource = {
    name: "memory-postgrest",
    rolesFor: (tenant): CustomRole[] =>
      seeds.fixtures.customRoles.flatMap((role) => {
        const id = seeds.fixtures.tenants[role.tenant]?.id ?? role.tenant;
        if (id !== tenant && role.tenant !== tenant) {
          return [];
        }
        return [
          {
            name: role.key,
            tenant: id,
            grants: role.grants.map((permission) => ({ permission })),
          },
        ];
      }),
  };
  return { memberships, customRoles };
}
