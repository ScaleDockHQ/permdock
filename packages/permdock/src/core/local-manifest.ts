import type {
  LocalCustomRoleTable,
  LocalSnapshotManifest,
  SnapshotGrant,
} from "./interfaces.ts";
import type { Grant, Policy } from "./policy.ts";
import type { CustomRoleGrant } from "./subject.ts";

import { compact } from "./compact.ts";
import { ceilingGrants, resolveCustomRole } from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { flattenGrantee } from "./grantee.ts";
import { snapshotScopes } from "./instance.ts";
import { LOCAL_CUSTOM_ROLE } from "./local-role.ts";
import { rankRoles, usesAssigns } from "./ownership.ts";
import { findPermission } from "./permissions.ts";
import { declaredRoleNames, grantList, levelNames } from "./policy.ts";
import { scopeList } from "./scopes.ts";
import { buildSnapshot, snapshotGrant } from "./snapshot.ts";

/** A relation grantee needs the relation graph, which a device does not hold: the grant decides on the server only. */
function localGrant(grant: Grant): SnapshotGrant {
  const relational = flattenGrantee(grant.to).some(
    (item) => item.kind === "relation",
  );
  return snapshotGrant(
    relational ? { ...grant, portable: false } : grant,
    undefined,
  );
}

function customTable(
  policy: Policy,
  scope: string,
  roles: readonly string[],
): LocalCustomRoleTable | undefined {
  const keys = [
    ...new Set(
      ceilingGrants(policy, scope).map((grant) => grant.permission.key),
    ),
  ];
  if (keys.length === 0) {
    return undefined;
  }
  const resolve = (body: {
    readonly grants?: readonly CustomRoleGrant[];
    readonly includes?: readonly string[];
  }): readonly SnapshotGrant[] =>
    resolveCustomRole(
      policy,
      scope === "global"
        ? { name: LOCAL_CUSTOM_ROLE, scope: "global", ...body }
        : {
            name: LOCAL_CUSTOM_ROLE,
            tenant: LOCAL_CUSTOM_ROLE,
            scope,
            ...body,
          },
    ).grants.map(localGrant);
  const permissions: Record<
    string,
    LocalCustomRoleTable["permissions"][string]
  > = {};
  for (const key of keys) {
    const leaf = findPermission(policy.permissions, key);
    const names =
      leaf?.kind === "instance" ? levelNames(policy, leaf.resource) : [];
    permissions[key] = compact({
      all: resolve({ grants: [{ permission: key }] }),
      levels:
        names.length === 0
          ? undefined
          : Object.fromEntries(
              names.map((level) => [
                level,
                resolve({ grants: [{ permission: key, level }] }),
              ]),
            ),
    });
  }
  const includes: Record<string, readonly SnapshotGrant[]> = {};
  for (const role of roles) {
    const grants = resolve({ includes: [role] });
    if (grants.length > 0) {
      includes[role] = grants;
    }
  }
  return { permissions, includes };
}

/**
 * What the policy grants, as JSON a device turns into snapshots from its own
 * membership rows (`localSnapshot` in `permdock/react-native`). Write it at
 * build time; the policy itself never ships to the client.
 */
export function localSnapshotManifest(policy: Policy): LocalSnapshotManifest {
  const roles = [...declaredRoleNames(policy)].toSorted();
  const custom: Record<string, LocalCustomRoleTable> = {};
  for (const scope of [
    ...scopeList(policy.scopes).map((item) => item.name),
    "global",
  ]) {
    const table = customTable(policy, scope, roles);
    if (table !== undefined) {
      custom[scope] = table;
    }
  }
  const scopes = snapshotScopes(policy);
  const { vocabulary } = buildSnapshot({
    subject: { principal: null, context: {} },
    roles: [],
    grants: [],
    vocabulary: policy.vocabulary,
  });
  return freezeDeep(
    compact<LocalSnapshotManifest>({
      v: 1 as const,
      scopes,
      vocabulary,
      roles,
      rank: usesAssigns(policy) ? rankRoles(policy, roles) : undefined,
      grants: grantList(policy).map(localGrant),
      custom,
    }),
  );
}
