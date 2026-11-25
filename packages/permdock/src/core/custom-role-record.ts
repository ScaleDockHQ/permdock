import type {
  CustomRecordMemo,
  Policy,
  PolicyVocabulary,
} from "./policy-types.ts";
import type {
  CustomRoleRecord,
  ExpandedSnapshot,
  SnapshotCustom,
} from "./snapshot-types.ts";
import type { CustomRole, Membership, Principal } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import {
  PROBE,
  canonOf,
  probeGroup,
  probeSnapshot,
  sameList,
} from "./client-bundle.ts";
import {
  customRoleOf,
  isGlobalCustomRole,
  tenantCustomRoles,
} from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { resolveScope, scopeList, tenantOf } from "./scopes.ts";
import { sha256Digest } from "./sha256.ts";

/** The membership a holder of a tenant role has: on its scope, in `tenant`. */
function membershipFor(
  policy: Policy,
  role: CustomRole,
  tenant: string,
): Membership | undefined {
  const scopes = scopeList(policy.scopes);
  const root = scopes[0];
  const scope =
    root === undefined
      ? undefined
      : resolveScope(scopes, role.scope ?? root.name);
  if (root === undefined || scope === undefined) {
    return undefined;
  }
  const within: Record<string, string> = {};
  let parent = scopes.find((item) => item.name === scope)?.within;
  while (parent !== undefined) {
    within[parent] = parent === root.name ? tenant : PROBE;
    const name: string = parent;
    parent = scopes.find((item) => item.name === name)?.within;
  }
  return {
    scope,
    id: scope === root.name ? tenant : PROBE,
    ...(Object.keys(within).length === 0 ? {} : { within }),
    roles: [role.name],
  };
}

function build(
  policy: Policy,
  customRoles: readonly CustomRole[],
  tenant: string | null,
): CustomRecordMemo {
  const roles: Record<string, CustomRoleRecord["roles"][string]> = {};
  const expected = new Map<string, readonly string[]>();
  const candidates =
    tenant === null
      ? customRoles.filter(isGlobalCustomRole)
      : tenantCustomRoles(policy, customRoles).filter((role) =>
          customRoleOf(role, tenant),
        );
  for (const role of candidates.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    // A role pinned to one instance, or to one team, depends on an id the record cannot hold.
    if (role.id !== undefined || role.team !== undefined) {
      continue;
    }
    const membership =
      tenant === null ? undefined : membershipFor(policy, role, tenant);
    if (tenant !== null && membership === undefined) {
      continue;
    }
    const principal: Principal = {
      id: PROBE,
      roles: membership === undefined ? [role.name] : [],
      ...(membership === undefined ? {} : { memberships: [membership] }),
    };
    const snapshot = probeSnapshot(policy, principal, customRoles);
    const group = probeGroup(snapshot, (grant) => grant.role === role.name);
    if (group === undefined) {
      continue;
    }
    expected.set(role.name, group.canon);
    roles[role.name] = {
      digest: sha256Digest(canonicalJson(group.canon)),
      grants: group.terms,
    };
  }
  return { record: freezeDeep({ v: 1 as const, tenant, roles }), expected };
}

function recordedFor(
  policy: Policy,
  customRoles: readonly CustomRole[],
  tenant: string | null,
): CustomRecordMemo {
  let byTenant = policy.index.customRecords.get(customRoles);
  if (byTenant === undefined) {
    byTenant = new Map();
    policy.index.customRecords.set(customRoles, byTenant);
  }
  let recorded = byTenant.get(tenant);
  if (recorded === undefined) {
    recorded = build(policy, customRoles, tenant);
    byTenant.set(tenant, recorded);
  }
  return recorded;
}

/**
 * The grants of the custom roles `tenant` holds (its own and the shared ones),
 * or of the platform's global custom roles for `null`. Pass the record to
 * `fromSnapshot` and the client store next to a snapshot `snapshotFor` wrote
 * with `customRoles`; the snapshot names the roles and the record supplies what
 * they grant. Cache it with the custom roles, once per tenant and version. Pure
 * and deterministic for one policy and one list of roles.
 */
export function customRoleRecord<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  customRoles: readonly CustomRole[],
  tenant: string | null,
): CustomRoleRecord {
  // SAFETY: the generics only type the caller's side; the record reads the erased policy.
  return recordedFor(policy as unknown as Policy, customRoles, tenant).record;
}

/**
 * `expanded` without the grants of custom roles the tenant records reproduce
 * exactly, and the `custom` entry that names them. A group that differs from
 * its record in any term stays inline, so a client never rebuilds a rule.
 */
export function withoutCustomGrants(
  policy: Policy,
  expanded: ExpandedSnapshot,
  customRoles: readonly CustomRole[],
): {
  readonly snapshot: ExpandedSnapshot;
  readonly custom: SnapshotCustom | undefined;
} {
  if (customRoles.length === 0) {
    return { snapshot: expanded, custom: undefined };
  }
  const scopes = scopeList(policy.scopes);
  const memberships = expanded.subject.principal?.memberships ?? [];
  const memberAt = new Map<string, number>();
  for (const [at, membership] of memberships.entries()) {
    const key = canonicalJson(membership);
    if (!memberAt.has(key)) {
      memberAt.set(key, at);
    }
  }
  const groups = new Map<
    string,
    {
      role: string;
      tenant: string | null;
      member: number | null;
      at: number[];
      canon: string[];
    }
  >();
  for (const [at, grant] of expanded.grants.entries()) {
    const role = grant.role;
    if (role === null) {
      continue;
    }
    const tenant =
      grant.membership === undefined
        ? null
        : (tenantOf(grant.membership, scopes) ?? null);
    const member =
      grant.membership === undefined
        ? null
        : (memberAt.get(canonicalJson(grant.membership)) ?? null);
    if (
      grant.membership !== undefined &&
      (member === null || tenant === null)
    ) {
      continue;
    }
    const recorded = recordedFor(policy, customRoles, tenant);
    if (!recorded.expected.has(role)) {
      continue;
    }
    const id = `${role}\u0000${String(member)}`;
    const group = groups.get(id) ?? { role, tenant, member, at: [], canon: [] };
    group.at.push(at);
    group.canon.push(canonOf(grant, expanded));
    groups.set(id, group);
  }
  const removed = new Set<number>();
  const held: [string, number | null, string][] = [];
  for (const group of groups.values()) {
    const recorded = recordedFor(policy, customRoles, group.tenant);
    const want = recorded.expected.get(group.role);
    const entry = recorded.record.roles[group.role];
    if (
      want === undefined ||
      entry === undefined ||
      !sameList(group.canon, want)
    ) {
      continue;
    }
    for (const at of group.at) {
      removed.add(at);
    }
    held.push([group.role, group.member, entry.digest]);
  }
  if (held.length === 0) {
    return { snapshot: expanded, custom: undefined };
  }
  return {
    snapshot: {
      ...expanded,
      grants: expanded.grants.filter((_, at) => !removed.has(at)),
    },
    custom: { held },
  };
}
