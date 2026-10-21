import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Delegation } from "./subject.ts";

import { byCodePoint } from "./compare.ts";
import { formerScopes, keyToScope } from "./permission-leaf.ts";

type ScopedPolicy = Pick<Policy, "oauthScopes">;
type ScopedPermission = Pick<Permission, "key" | "scope">;

/** A catalog permission as the scope map reads it. */
export type ScopeMapPermission = {
  readonly key: string;
  readonly scope: string;
  readonly renamedFrom?: readonly string[];
};

/** A catalog `oauthScopes` entry as the scope map reads it. */
export type ScopeMapEntry = {
  readonly scope: string;
  readonly permissions: readonly string[];
};

/**
 * Every OAuth scope a token may carry to the permission keys it reaches: each
 * permission's own scope, the scopes of the keys it was renamed from, and each
 * coarse `oauthScopes` scope. Scopes and keys are sorted by code point. A key
 * outside `permissions` is dropped, so a stale `oauthScopes` entry grants
 * nothing. better-supabase's `delegation.scopes` and the SQL helpers'
 * `rls.tokenScopes` ceiling both read this map.
 */
export function delegatedScopeMap(
  permissions: readonly ScopeMapPermission[],
  oauthScopes: readonly ScopeMapEntry[] = [],
): Record<string, string[]> {
  const delegated = new Map<string, Set<string>>();
  const add = (scope: string, key: string): void => {
    const keys = delegated.get(scope) ?? new Set();
    keys.add(key);
    delegated.set(scope, keys);
  };
  const known = new Set<string>();
  for (const permission of permissions) {
    known.add(permission.key);
    add(permission.scope, permission.key);
    for (const former of permission.renamedFrom ?? []) {
      add(keyToScope(former), permission.key);
    }
  }
  for (const entry of oauthScopes) {
    for (const key of entry.permissions) {
      if (known.has(key)) add(entry.scope, key);
    }
  }
  return Object.fromEntries(
    [...delegated.keys()]
      .toSorted(byCodePoint)
      .map((scope) => [
        scope,
        [...(delegated.get(scope) ?? [])].toSorted(byCodePoint),
      ]),
  );
}

/**
 * `delegation` with every coarse OAuth scope the policy declares in
 * `oauthScopes` followed by the scopes of the permissions it covers, so the
 * delegation checks downstream match them. The token's scopes stay first and
 * unchanged; an undeclared scope expands to nothing.
 */
export function expandOAuthScopes(
  policy: ScopedPolicy,
  delegation: Delegation | undefined,
): Delegation | undefined {
  const declared = policy.oauthScopes;
  const scopes = delegation?.scopes;
  if (
    declared === undefined ||
    delegation === undefined ||
    scopes === undefined
  ) {
    return delegation;
  }
  const out = new Set(scopes);
  for (const entry of declared) {
    if (scopes.includes(entry.scope)) {
      for (const scope of entry.scopes) {
        out.add(scope);
      }
    }
  }
  return out.size === scopes.length
    ? delegation
    : { ...delegation, scopes: [...out] };
}

/** The coarse scopes the policy declares that cover `permission`, in declaration order. */
function coarseScopesFor(
  policy: ScopedPolicy,
  permission: ScopedPermission,
): readonly string[] {
  return (policy.oauthScopes ?? [])
    .filter((entry) => entry.permissions.includes(permission.key))
    .map((entry) => entry.scope);
}

/** Every token scope that reaches `permission`: its own, any it was renamed from, and the coarse scopes covering it. */
export function scopesReaching(
  policy: ScopedPolicy,
  permission: ScopedPermission,
): readonly string[] {
  return [
    permission.scope,
    ...formerScopes(permission),
    ...coarseScopesFor(policy, permission),
  ];
}

/**
 * The scope an `insufficient_scope` challenge names for `permission`: the
 * first coarse scope that covers it, which the authorization server issues,
 * else the permission's own scope.
 */
export function challengeScope(
  policy: ScopedPolicy,
  permission: ScopedPermission,
): string {
  return coarseScopesFor(policy, permission)[0] ?? permission.scope;
}

/** Whether a token holding `granted` carries any of `scopes`. */
export function hasScope(
  granted: readonly string[] | undefined,
  scopes: readonly string[],
): boolean {
  return scopes.some((scope) => granted?.includes(scope) === true);
}
