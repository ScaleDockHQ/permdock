import type { Permission } from "./permissions.ts";
import type { Policy } from "./policy.ts";
import type { Delegation } from "./subject.ts";

import { formerScopes } from "./permissions.ts";

type ScopedPolicy = Pick<Policy, "oauthScopes">;
type ScopedPermission = Pick<Permission, "key" | "scope">;

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
