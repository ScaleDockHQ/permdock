import type { Grant, Policy } from "./policy-types.ts";
import type {
  LocalAssignable,
  LocalCustomRoleTable,
  LocalSnapshotManifest,
  SnapshotGrant,
} from "./snapshot-types.ts";
import type { CustomRoleGrant } from "./subject.ts";

import { assignableCandidates, heldLevels } from "./assignable.ts";
import { compact } from "./compact.ts";
import {
  ceilingGrants,
  resolveCustomRole,
  roleAllowKeys,
} from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { flattenGrantee } from "./grantee.ts";
import { snapshotScopes } from "./instance-snapshot.ts";
import { LOCAL_CUSTOM_ROLE } from "./local-role.ts";
import { findPermission, listPermissions } from "./permission-registry.ts";
import { declaredRoleNames, grantList, levelNames } from "./policy.ts";
import { rankRoles, roleMeta, usesAssigns } from "./role-rank.ts";
import { resolveScope, rootScope, scopeList } from "./scopes.ts";
import { buildSnapshot, plainPermission, snapshotGrant } from "./snapshot.ts";

/**
 * A relation grantee needs the relation graph, which a device does not hold:
 * the grant decides on the server only.
 */
function localGrant(grant: Grant): SnapshotGrant {
  const relational = flattenGrantee(grant.to).some(
    (item) => item.kind === "relation",
  );
  return snapshotGrant(
    relational ? { ...grant, portable: false } : grant,
    undefined,
  );
}

/**
 * The levels a holder of `grants` may hand out, by permission key; only
 * permissions whose resource declares levels.
 */
function reachOf(
  policy: Policy,
  grants: readonly Grant[],
): Readonly<Record<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  for (const grant of grants) {
    const { key, resource, kind } = grant.permission;
    const names =
      grant.effect === "allow" && kind === "instance"
        ? levelNames(policy, resource)
        : [];
    if (names.length === 0) {
      continue;
    }
    const held = new Set([
      ...(out.get(key) ?? []),
      ...heldLevels(policy, grant, names),
    ]);
    out.set(
      key,
      names.filter((name) => held.has(name)),
    );
  }
  return Object.fromEntries(out);
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
  }): readonly Grant[] =>
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
    ).grants;
  const permissions: Record<
    string,
    LocalCustomRoleTable["permissions"][string]
  > = {};
  for (const key of keys) {
    const leaf = findPermission(policy.permissions, key);
    const names =
      leaf?.kind === "instance" ? levelNames(policy, leaf.resource) : [];
    const all = resolve({ grants: [{ permission: key }] });
    const leveled = names.map(
      (level) =>
        [level, resolve({ grants: [{ permission: key, level }] })] as const,
    );
    permissions[key] = compact({
      all: all.map(localGrant),
      levels:
        names.length === 0
          ? undefined
          : Object.fromEntries(
              leveled.map(([level, grants]) => [level, grants.map(localGrant)]),
            ),
      reach: names.length === 0 ? undefined : (reachOf(policy, all)[key] ?? []),
      levelReach:
        names.length === 0
          ? undefined
          : Object.fromEntries(
              leveled.map(([level, grants]) => [
                level,
                reachOf(policy, grants)[key] ?? [],
              ]),
            ),
    });
  }
  const includes: Record<string, readonly SnapshotGrant[]> = {};
  const includeReach: Record<
    string,
    Readonly<Record<string, readonly string[]>>
  > = {};
  for (const role of roles) {
    const grants = resolve({ includes: [role] });
    if (grants.length > 0) {
      includes[role] = grants.map(localGrant);
      const reach = reachOf(policy, grants);
      if (Object.keys(reach).length > 0) {
        includeReach[role] = reach;
      }
    }
  }
  return compact({
    permissions,
    includes,
    includeReach:
      Object.keys(includeReach).length === 0 ? undefined : includeReach,
  });
}

/** The hand-out rules `buildLocalSnapshot` applies on the device. */
function localAssignable(policy: Policy): LocalAssignable {
  const scopes = scopeList(policy.scopes);
  const root = rootScope(scopes);
  const ceiling = new Set(
    (root === undefined ? [] : ceilingGrants(policy, root)).map(
      (grant) => grant.permission.key,
    ),
  );
  const leaves = listPermissions(policy.permissions);
  const levels: Record<string, readonly string[]> = {};
  for (const leaf of leaves) {
    const names =
      leaf.kind === "instance" ? levelNames(policy, leaf.resource) : [];
    if (names.length > 0) {
      levels[leaf.key] = names;
    }
  }
  const grants: Record<string, readonly string[]> = {};
  for (const [index, grant] of grantList(policy).entries()) {
    // The server holds a relation grant with the relation's row condition, which equals no level.
    const relational = flattenGrantee(grant.to).some(
      (item) => item.kind === "relation",
    );
    const reach = relational
      ? levels[grant.permission.key] === undefined
        ? undefined
        : []
      : reachOf(policy, [grant])[grant.permission.key];
    if (reach !== undefined) {
      grants[String(index)] = reach;
    }
  }
  const declared = [...declaredRoleNames(policy)].toSorted();
  return compact<LocalAssignable>({
    roles: assignableCandidates(policy).map((leaf) => ({
      name: leaf.key,
      on:
        (leaf.on === undefined ? root : resolveScope(scopes, leaf.on)) ??
        "global",
      allows: [...roleAllowKeys(policy, leaf.key)].toSorted(),
    })),
    manage: {
      roles: declared.filter(
        (name) => roleMeta(policy, name)?.manageRoles === true,
      ),
      permissions: leaves
        .filter((leaf) => leaf.meta.manageRoles === true)
        .map((leaf) => leaf.key),
    },
    assigns: usesAssigns(policy)
      ? Object.fromEntries(
          declared.map((name) => [
            name,
            policy.rolesByName.get(name)?.assigns ?? [],
          ]),
        )
      : undefined,
    permissions: leaves
      .filter((leaf) => ceiling.has(leaf.key))
      .map(plainPermission),
    levels: Object.keys(levels).length === 0 ? undefined : levels,
    grants: Object.keys(grants).length === 0 ? undefined : grants,
  });
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
      assignable: localAssignable(policy),
    }),
  );
}
