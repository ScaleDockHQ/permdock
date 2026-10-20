import type { Scope } from "./scopes.ts";
import type { Membership } from "./subject.ts";

import {
  normalizeMembership as normalizeOne,
  normalizeMemberships as normalizeAll,
  resolveScope as resolveName,
  scopeList,
} from "./scopes.ts";

/**
 * The canonical form PermDock evaluates one membership in, or `undefined`
 * when it is malformed and grants nothing. `scopes` is the policy's or the
 * catalog's scope list; absent or empty means the implicit `tenant` and
 * `team` pair.
 */
export function normalizeMembership(
  input: unknown,
  scopes?: readonly Scope[],
): Membership | undefined {
  return normalizeOne(input, scopeList(scopes));
}

/** Every well-formed membership of `input` in canonical form; malformed entries are dropped. */
export function normalizeMemberships(
  input: unknown,
  scopes?: readonly Scope[],
): readonly Membership[] {
  return normalizeAll(input, scopeList(scopes));
}

/**
 * The declared scope `name` stands for: the name itself, or the scope the
 * `tenant` (first) or `team` (second) alias names. `undefined` otherwise.
 */
export function resolveScope(
  scopes: readonly Scope[] | undefined,
  name: unknown,
): string | undefined {
  return resolveName(scopeList(scopes), name);
}
