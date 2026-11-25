import type { BundleMemo, Policy, PolicyVocabulary } from "./policy-types.ts";
import type {
  ClientBundle,
  ExpandedSnapshot,
  Snapshot,
  SnapshotCustom,
  SnapshotGrant,
  SnapshotStatic,
  SnapshotWireTerms,
} from "./snapshot-types.ts";
import type { CustomRole, Membership, Principal } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { freezeDeep } from "./freeze.ts";
import { snapshotOf, snapshotScopes } from "./instance-snapshot.ts";
import { listPermissions } from "./permission-registry.ts";
import { declaredRoleNames } from "./policy.ts";
import { roleMeta } from "./role-rank.ts";
import { resolveScope, scopeList } from "./scopes.ts";
import { sha256Digest } from "./sha256.ts";
import { compactSnapshot, internGrants } from "./snapshot-compact.ts";
import { withoutRequirement } from "./snapshot-requires.ts";
import { snapshotVocabulary } from "./snapshot.ts";
import { findRole } from "./vocabulary.ts";

/** What a role holder is checked against; no real id can equal it. */
export const PROBE = "$probe";

/**
 * A grant's terms as the wire writes them: without its membership, and without
 * the requirement its subject's `requires` table places.
 */
function wireTerms(
  grant: SnapshotGrant,
  snapshot: ExpandedSnapshot,
): SnapshotWireTerms & { readonly permission: string } {
  const { permission, membership: _membership, ...terms } = grant;
  return {
    permission,
    ...withoutRequirement(
      terms,
      snapshot.requires,
      snapshot.subject.principal?.memberships ?? [],
    ),
  };
}

export function canonOf(
  grant: SnapshotGrant,
  snapshot: ExpandedSnapshot,
): string {
  const { permission, ...terms } = wireTerms(grant, snapshot);
  return canonicalJson([permission, terms]);
}

/** The membership a probe holder of `role` has on `scope`, with its ancestors. */
function probeMembership(
  policy: Policy,
  role: string,
  scope: string,
): Membership {
  const scopes = scopeList(policy.scopes);
  const within: Record<string, string> = {};
  let parent = scopes.find((item) => item.name === scope)?.within;
  while (parent !== undefined) {
    within[parent] = PROBE;
    const name: string = parent;
    parent = scopes.find((item) => item.name === name)?.within;
  }
  return {
    scope,
    id: PROBE,
    ...(Object.keys(within).length === 0 ? {} : { within }),
    roles: [role],
  };
}

export function probeSnapshot(
  policy: Policy,
  principal: Principal,
  customRoles: readonly CustomRole[] = [],
): ExpandedSnapshot {
  return snapshotOf(
    policy,
    { principal, context: {} },
    { customRoles, omitAssignable: true, omitTypeLevel: true, tenants: "all" },
  );
}

/** A probe group as the bundle stores it: wire terms and their canon. */
export type ProbeGroup = {
  readonly terms: readonly (SnapshotWireTerms & {
    readonly permission: string;
  })[];
  readonly canon: readonly string[];
};

export function probeGroup(
  snapshot: ExpandedSnapshot,
  keep: (grant: SnapshotGrant) => boolean,
): ProbeGroup | undefined {
  const grants = snapshot.grants.filter(keep);
  return grants.length === 0
    ? undefined
    : {
        terms: grants.map((grant) => wireTerms(grant, snapshot)),
        canon: grants.map((grant) => canonOf(grant, snapshot)),
      };
}

/** The grants a holder of only `role` receives, or `undefined` when none. */
function roleGrants(policy: Policy, role: string): ProbeGroup | undefined {
  const on =
    policy.rolesByName.get(role)?.on ??
    findRole(policy.vocabulary?.roles, role)?.on;
  const scope =
    on === undefined ? undefined : resolveScope(scopeList(policy.scopes), on);
  if (on !== undefined && scope === undefined) {
    return undefined;
  }
  const membership =
    scope === undefined ? undefined : probeMembership(policy, role, scope);
  return probeGroup(
    probeSnapshot(policy, {
      id: PROBE,
      roles: membership === undefined ? [role] : [],
      ...(membership === undefined ? {} : { memberships: [membership] }),
    }),
    (grant) => grant.role === role,
  );
}

/** A grant held without a role or membership: the bundle's shared group. */
function isShared(grant: SnapshotGrant): boolean {
  return grant.role === null && grant.membership === undefined;
}

/**
 * The static grants of every declared role, as a document the app ships as a
 * cached script and passes to its provider. Pair it with `omitStatic` on the
 * snapshot. A role with `meta.clientBundle: false` is left out and stays inline
 * in the snapshot. Pure and deterministic for one policy.
 */
export function clientBundle<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(policy: Policy<TUser, TPrincipal, V>): ClientBundle {
  // SAFETY: the generics only type the caller's side; the bundle reads the erased policy.
  return memoOf(policy as unknown as Policy).bundle;
}

function memoOf(policy: Policy): BundleMemo {
  const known = policy.index.bundle.get(policy);
  if (known !== undefined) {
    return known;
  }
  const names = [...declaredRoleNames(policy)]
    .filter((name) => roleMeta(policy, name)?.clientBundle !== false)
    .toSorted();
  const pool: SnapshotWireTerms[] = [];
  const index = new Map<string, number>();
  const roles: Record<string, ClientBundle["roles"][string]> = {};
  const expected = new Map<string, readonly string[]>();
  const pooled = (group: ProbeGroup): ClientBundle["roles"][string] => {
    const interned = internGrants(group.terms);
    const remap = interned.conditions.map((terms): number => {
      const key = canonicalJson(terms);
      let at = index.get(key);
      if (at === undefined) {
        at = pool.length;
        index.set(key, at);
        pool.push(terms);
      }
      return at;
    });
    return {
      digest: sha256Digest(canonicalJson(group.canon)),
      grants: interned.grants.map((grant) => ({
        permission: grant.permission,
        cond: Array.isArray(grant.cond)
          ? grant.cond.map((at) => remap[at] ?? at)
          : (remap[grant.cond] ?? grant.cond),
      })),
    };
  };
  for (const name of names) {
    const group = roleGrants(policy, name);
    if (group !== undefined) {
      expected.set(name, group.canon);
      roles[name] = pooled(group);
    }
  }
  const sharedGroup = probeGroup(
    probeSnapshot(policy, { id: PROBE, roles: [] }),
    isShared,
  );
  const shared = sharedGroup === undefined ? undefined : pooled(sharedGroup);
  const scopes = snapshotScopes(policy);
  const vocabulary = snapshotVocabulary(policy.vocabulary);
  const keys = listPermissions(policy.permissions)
    .map((leaf) => leaf.key)
    .toSorted();
  const bundle: ClientBundle = freezeDeep({
    v: 2 as const,
    digest: sha256Digest(canonicalJson({ vocabulary, scopes, keys })),
    keys,
    conditions: pool,
    roles,
    ...(shared === undefined ? {} : { shared }),
    ...(vocabulary === undefined ? {} : { vocabulary }),
    ...(scopes === undefined ? {} : { scopes }),
  });
  const memo: BundleMemo = {
    bundle,
    expected,
    ...(sharedGroup === undefined ? {} : { shared: sharedGroup.canon }),
  };
  policy.index.bundle.set(policy, memo);
  return memo;
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, at) => item === b[at]);
}

/**
 * The wire snapshot with every group the bundle reproduces exactly left out of
 * `grants`. A group is a role's grants through one membership; one that differs
 * from the bundle in any term (a bound claim, a plan gate, a delegation, an
 * `include`) stays inline, so the client never rebuilds a rule.
 */
export function compactWithBundle(
  policy: Policy,
  expanded: ExpandedSnapshot,
  custom?: SnapshotCustom,
): Snapshot {
  const { bundle, expected: expectedByRole, shared } = memoOf(policy);
  const memberships = expanded.subject.principal?.memberships ?? [];
  const memberAt = new Map<string, number>();
  for (const [at, membership] of memberships.entries()) {
    const key = canonicalJson(membership);
    if (!memberAt.has(key)) {
      memberAt.set(key, at);
    }
  }
  const keys = new WeakMap<object, string>();
  const groups = new Map<
    string,
    { role: string; member: string; at: number[]; canon: string[] }
  >();
  const sharedAt: number[] = [];
  const sharedCanon: string[] = [];
  for (const [at, grant] of expanded.grants.entries()) {
    const role = grant.role;
    if (isShared(grant)) {
      sharedAt.push(at);
      sharedCanon.push(canonOf(grant, expanded));
      continue;
    }
    if (role === null || !expectedByRole.has(role)) {
      continue;
    }
    let member = "";
    if (grant.membership !== undefined) {
      member = keys.get(grant.membership) ?? canonicalJson(grant.membership);
      keys.set(grant.membership, member);
    }
    const id = `${role}\u0000${member}`;
    const group = groups.get(id) ?? { role, member, at: [], canon: [] };
    group.at.push(at);
    group.canon.push(canonOf(grant, expanded));
    groups.set(id, group);
  }
  const removed = new Set<number>();
  const held: [string, number | null][] = [];
  const digests: Record<string, string> = {};
  for (const group of groups.values()) {
    const want = expectedByRole.get(group.role);
    const entry = bundle.roles[group.role];
    if (
      want === undefined ||
      entry === undefined ||
      !sameList(group.canon, want)
    ) {
      continue;
    }
    const index = group.member === "" ? null : memberAt.get(group.member);
    if (index === undefined) {
      continue;
    }
    for (const at of group.at) {
      removed.add(at);
    }
    held.push([group.role, index]);
    digests[group.role] = entry.digest;
  }
  const sharedDigest =
    shared !== undefined &&
    bundle.shared !== undefined &&
    sameList(sharedCanon, shared)
      ? bundle.shared.digest
      : undefined;
  if (sharedDigest !== undefined) {
    for (const at of sharedAt) {
      removed.add(at);
    }
  }
  if (held.length === 0 && sharedDigest === undefined) {
    return compactSnapshot(expanded, undefined, bundle, custom);
  }
  const wire: SnapshotStatic = {
    held,
    digests,
    ...(sharedDigest === undefined ? {} : { shared: sharedDigest }),
  };
  return compactSnapshot(
    {
      ...expanded,
      grants: expanded.grants.filter((_, at) => !removed.has(at)),
    },
    wire,
    bundle,
    custom,
  );
}
