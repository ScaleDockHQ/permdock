import type { Membership } from './subject.ts';

import { isForbiddenKey } from './paths.ts';

/** One entry of `definePolicy({ scopes })`: the row field holding the scope id, and its parent scope. */
export type ScopeDeclaration = {
  readonly key: string;
  readonly within?: string;
};

export type PolicyScopesInput = Readonly<Record<string, ScopeDeclaration>>;

/**
 * A declared scope, in declaration order. `key` is absent only on the
 * implicit `tenant` / `team` pair of a policy that declares no scopes.
 */
export type Scope = {
  readonly name: string;
  readonly key?: string;
  readonly within?: string;
};

/** The names `role(..., { on })`, `memberOf` and memberships may use: declared names plus the aliases. */
export type ScopeNames<S> = [S] extends [PolicyScopesInput]
  ? string extends keyof S
    ? string
    : (keyof S & string) | 'tenant' | 'team'
  : string;

const RESERVED = new Set(['global', 'resource']);
const NAME = /^[a-z][a-z0-9_]*$/u;

/** A policy without `scopes` keeps the historical pair: `tenant`, and `team` inside it. */
const IMPLICIT: readonly Scope[] = Object.freeze([
  Object.freeze({ name: 'tenant' }),
  Object.freeze({ name: 'team', within: 'tenant' }),
]);

function fail(message: string): never {
  throw new Error(`PermDock: ${message}`);
}

/**
 * Validates `definePolicy({ scopes })`. Declaration order is the scope order;
 * every scope after the first names an earlier one in `within`, so the scopes
 * form one tree rooted at the first and have no cycles.
 * A scope named `tenant` is the first and `team` the second, so the aliases
 * never point at two different scopes.
 */
export function defineScopes(
  input: PolicyScopesInput | undefined,
): readonly Scope[] {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('definePolicy({ scopes }) must be an object');
  }
  const out: Scope[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(input)) {
    if (isForbiddenKey(name) || RESERVED.has(name) || !NAME.test(name)) {
      fail(
        `scope name '${name}' must be lower snake case and not global or resource`,
      );
    }
    const declaration = input[name];
    if (
      declaration === undefined ||
      declaration === null ||
      typeof declaration !== 'object' ||
      typeof declaration.key !== 'string' ||
      declaration.key === ''
    ) {
      fail(`scopes.${name} needs a key`);
    }
    const index = out.length;
    if (name === 'tenant' && index !== 0) {
      fail("scope 'tenant' must be declared first");
    }
    if (name === 'team' && index !== 1) {
      fail("scope 'team' must be declared second");
    }
    const within = declaration.within;
    if (within !== undefined && !seen.has(within)) {
      fail(
        `scopes.${name}.within names '${within}', which is not declared before it`,
      );
    }
    if (name === 'team' && within === undefined && seen.has('tenant')) {
      fail("scopes.team needs within: 'tenant'");
    }
    if (index > 0 && within === undefined) {
      fail(
        `scopes.${name} needs within: every scope after the first sits inside an earlier one`,
      );
    }
    seen.add(name);
    out.push(
      Object.freeze(
        within === undefined
          ? { name, key: declaration.key }
          : { name, key: declaration.key, within },
      ),
    );
  }
  return Object.freeze(out);
}

/** The scopes a policy or snapshot evaluates with: the declared list, or the implicit pair. */
export function scopeList(
  declared: readonly Scope[] | undefined,
): readonly Scope[] {
  return declared === undefined || declared.length === 0 ? IMPLICIT : declared;
}

/** A declared name, or an alias: `tenant` is the first scope, `team` the second. */
export function resolveScope(
  scopes: readonly Scope[],
  name: unknown,
): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  if (scopes.some((scope) => scope.name === name)) {
    return name;
  }
  if (name === 'tenant') {
    return scopes[0]?.name;
  }
  if (name === 'team') {
    return scopes[1]?.name;
  }
  return undefined;
}

export function findScope(
  scopes: readonly Scope[],
  name: string,
): Scope | undefined {
  return scopes.find((scope) => scope.name === name);
}

/** `name` and its ancestors, innermost first. */
export function scopeChain(
  scopes: readonly Scope[],
  name: string,
): readonly string[] {
  const chain: string[] = [];
  let current = findScope(scopes, name);
  while (current !== undefined && !chain.includes(current.name)) {
    chain.push(current.name);
    current =
      current.within === undefined
        ? undefined
        : findScope(scopes, current.within);
  }
  return chain;
}

/** The scope the active tenant selects an instance of: the first declared one. */
export function rootScope(scopes: readonly Scope[]): string | undefined {
  return scopes[0]?.name;
}

/** The id a membership holds for `scope`: its own id, or the `within` entry of an ancestor. */
export function scopeIdOf(
  membership: Membership,
  scope: string,
): string | undefined {
  if (membership.scope === scope) {
    return membership.id;
  }
  const within = membership.within;
  if (within === undefined || !Object.hasOwn(within, scope)) {
    return undefined;
  }
  return within[scope];
}

/**
 * A membership of the first scope itself (the only scope without a parent):
 * its id is a tenant. Needs no scope list, for code that holds only a subject.
 */
export function rootMembershipId(membership: Membership): string | undefined {
  if (membership.scope !== undefined) {
    return membership.within === undefined ? membership.id : undefined;
  }
  return membership.team === undefined ? membership.tenant : undefined;
}

/** The instance of the first scope a membership sits in; what the active tenant selects. */
export function tenantOf(
  membership: Membership,
  scopes: readonly Scope[],
): string | undefined {
  const root = rootScope(scopes);
  return root === undefined ? undefined : scopeIdOf(membership, root);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function roleList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * The canonical form of one membership, or `undefined` when it is malformed
 * (fail-closed: it grants nothing). A named membership is
 * `{ scope, id, within }` with one `within` entry per ancestor of `scope`;
 * the `tenant` / `team` input shape and alias names normalise to it. A
 * resource membership keeps `on`. Shapes are exclusive.
 */
export function normalizeMembership(
  input: unknown,
  scopes: readonly Scope[],
): Membership | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const roles = roleList(raw.roles);
  if (roles === undefined) {
    return undefined;
  }
  const extra: { via?: string; expiresAt?: number } = {};
  if (typeof raw.via === 'string') {
    extra.via = raw.via;
  }
  if (typeof raw.expiresAt === 'number') {
    extra.expiresAt = raw.expiresAt;
  }
  const named = raw.scope !== undefined || raw.id !== undefined;
  const legacy = raw.tenant !== undefined || raw.team !== undefined;
  const on = raw.on;
  if (on !== undefined) {
    if (named || legacy || on === null || typeof on !== 'object') {
      return undefined;
    }
    const target = on as Record<string, unknown>;
    if (!isId(target.resource) || !isId(target.id)) {
      return undefined;
    }
    return Object.freeze({
      on: Object.freeze({ resource: target.resource, id: target.id }),
      roles: Object.freeze([...roles]),
      ...extra,
    });
  }
  let scope: string | undefined;
  let id: unknown;
  let within: Record<string, unknown> = {};
  if (named) {
    if (legacy) {
      return undefined;
    }
    scope = resolveScope(scopes, raw.scope);
    id = raw.id;
    if (raw.within !== undefined) {
      if (
        raw.within === null ||
        typeof raw.within !== 'object' ||
        Array.isArray(raw.within)
      ) {
        return undefined;
      }
      within = raw.within as Record<string, unknown>;
    }
  } else if (raw.team !== undefined) {
    scope = resolveScope(scopes, 'team');
    id = raw.team;
    const parent = resolveScope(scopes, 'tenant');
    if (raw.tenant !== undefined && parent !== undefined) {
      within = { [parent]: raw.tenant };
    }
  } else if (raw.tenant === undefined) {
    return undefined;
  } else {
    scope = resolveScope(scopes, 'tenant');
    id = raw.tenant;
  }
  if (scope === undefined || !isId(id)) {
    return undefined;
  }
  const ancestors = scopeChain(scopes, scope).slice(1);
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(within)) {
    if (isForbiddenKey(key)) {
      return undefined;
    }
    const name = resolveScope(scopes, key);
    const value = within[key];
    if (name !== undefined && ancestors.includes(name) && isId(value)) {
      resolved[name] = value;
    }
  }
  if (ancestors.some((name) => resolved[name] === undefined)) {
    return undefined;
  }
  return Object.freeze({
    scope,
    id,
    ...(ancestors.length === 0 ? {} : { within: Object.freeze(resolved) }),
    roles: Object.freeze([...roles]),
    ...extra,
  });
}

export function normalizeMemberships(
  input: unknown,
  scopes: readonly Scope[],
): readonly Membership[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: Membership[] = [];
  for (const item of input) {
    const membership = normalizeMembership(item, scopes);
    if (membership !== undefined) {
      out.push(membership);
    }
  }
  return out;
}

/**
 * A subject's memberships in canonical form. Resolved subjects already are;
 * this accepts a hand-built subject passed straight to a condition evaluator
 * or compiler.
 */
export function subjectMemberships(
  memberships: readonly Membership[] | undefined,
  scopes: readonly Scope[],
): readonly Membership[] {
  const list = memberships ?? [];
  const legacy = list.some(
    (membership) =>
      membership.tenant !== undefined || membership.team !== undefined,
  );
  return legacy ? normalizeMemberships(list, scopes) : list;
}
