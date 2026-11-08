import type { BundleMemo, Policy, PolicyVocabulary } from "./policy-types.ts";
import type {
  ClientBundle,
  ExpandedSnapshot,
  Snapshot,
  SnapshotGrant,
  SnapshotGrantTerms,
  SnapshotStatic,
} from "./snapshot-types.ts";
import type { Membership, Principal } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { snapshotOf } from "./instance-snapshot.ts";
import { declaredRoleNames } from "./policy.ts";
import { roleMeta } from "./role-rank.ts";
import { resolveScope, scopeList } from "./scopes.ts";
import { sha256Digest } from "./sha256.ts";
import { compactSnapshot, internGrants } from "./snapshot-compact.ts";
import { findRole } from "./vocabulary.ts";

/** What a role holder is checked against; no real id can equal it. */
const PROBE = "$probe";

function termsOf(grant: SnapshotGrant): {
  readonly permission: string;
  readonly terms: SnapshotGrantTerms;
} {
  const { permission, membership: _membership, ...terms } = grant;
  return { permission, terms };
}

function canonOf(grant: SnapshotGrant): string {
  const { permission, terms } = termsOf(grant);
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

/** The grants a holder of only `role` receives, or `undefined` when none. */
function roleGrants(
  policy: Policy,
  role: string,
): readonly SnapshotGrant[] | undefined {
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
  const snapshot = snapshotOf(
    policy,
    {
      principal: {
        id: PROBE,
        roles: membership === undefined ? [role] : [],
        ...(membership === undefined ? {} : { memberships: [membership] }),
      },
      context: {},
    },
    {
      customRoles: [],
      omitAssignable: true,
      omitTypeLevel: true,
      tenants: "all",
    },
  );
  const grants = snapshot.grants.filter((grant) => grant.role === role);
  return grants.length === 0 ? undefined : grants;
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
  const pool: SnapshotGrantTerms[] = [];
  const index = new Map<string, number>();
  const roles: Record<string, ClientBundle["roles"][string]> = {};
  const expected = new Map<string, readonly string[]>();
  for (const name of names) {
    const grants = roleGrants(policy, name);
    if (grants === undefined) {
      continue;
    }
    const interned = internGrants(
      grants.map((grant): SnapshotGrant => {
        const { membership: _membership, ...bare } = grant;
        return bare;
      }),
    );
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
    const mapped = interned.grants.map((grant) => ({
      permission: grant.permission,
      cond: Array.isArray(grant.cond)
        ? grant.cond.map((at) => remap[at] ?? at)
        : (remap[grant.cond] ?? grant.cond),
    }));
    const canon = grants.map(canonOf);
    expected.set(name, canon);
    roles[name] = {
      digest: sha256Digest(canonicalJson(canon)),
      grants: mapped,
    };
  }
  const bundle: ClientBundle = Object.freeze({
    v: 1,
    conditions: Object.freeze(pool),
    roles: Object.freeze(roles),
  });
  const memo: BundleMemo = { bundle, expected };
  policy.index.bundle.set(policy, memo);
  return memo;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
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
): Snapshot {
  const { bundle, expected: expectedByRole } = memoOf(policy);
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
  for (const [at, grant] of expanded.grants.entries()) {
    const role = grant.role;
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
    group.canon.push(canonOf(grant));
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
  if (held.length === 0) {
    return compactSnapshot(expanded);
  }
  const wire: SnapshotStatic = { held, digests };
  return compactSnapshot(
    {
      ...expanded,
      grants: expanded.grants.filter((_, at) => !removed.has(at)),
    },
    wire,
  );
}
