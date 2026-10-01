import type { Denial } from './decision.ts';
import type { Policy, RoleBinding } from './policy.ts';
import type { Membership, Principal } from './subject.ts';
import type { Role, RoleMeta } from './vocabulary.ts';

import { compact, isReadonlyArray } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { isExternallyManaged } from './memberships.ts';
import { declaredRoleNames } from './policy.ts';
import {
  type Scope,
  resolveScope,
  scopeChain,
  scopeIdOf,
  tenantOf,
} from './scopes.ts';
import { isMembershipExpired } from './tenancy.ts';
import { findRole, listRoles } from './vocabulary.ts';

/** Who a role change is about: their principal id and their membership in the scope instance. */
export type RoleChangeTarget = {
  readonly id: string;
  /** The kind of the target's membership in the instance (`staff`, `contact`, ...). */
  readonly via?: string;
  /** The roles the target holds in the instance now. */
  readonly roles?: readonly string[];
  /** `idp` when the identity provider owns the target's membership: the application cannot change it. */
  readonly managedBy?: 'idp';
};

export type RoleChange = {
  readonly kind: 'assign' | 'revoke' | 'transfer';
  readonly role: string | Role;
  /** The scope the role is held at (a declared name or alias). */
  readonly scope: string;
  /** The scope instance. */
  readonly id: string;
  /** Ids of the instance's ancestor scopes; a holder there may assign here. */
  readonly within?: Readonly<Record<string, string>>;
  readonly target: RoleChangeTarget;
  /**
   * How many principals hold `role` in the instance now, from the
   * application's store. Without it a role with `min`, `max` or
   * `transferOnly` is denied.
   */
  readonly holders?: number;
};

/**
 * `granted` names the role that authorised the change (`null` when a
 * `meta.manageRoles` holder or the declared-role ceiling did); `denied` lists
 * every rule the change breaks.
 */
export type RoleChangeDecision =
  | {
      readonly outcome: 'granted';
      readonly change: RoleChange;
      readonly role: string | null;
    }
  | {
      readonly outcome: 'denied';
      readonly change: RoleChange;
      readonly denials: readonly Denial[];
    };

function bindingOf(policy: Policy, name: string): RoleBinding | undefined {
  return policy.rolesByName.get(name);
}

export function roleMeta(policy: Policy, name: string): RoleMeta | undefined {
  return (
    bindingOf(policy, name)?.meta ??
    findRole(policy.vocabulary?.roles, name)?.meta
  );
}

/** A role with `for` is held only through a membership of one of those kinds. */
function mayHoldVia(
  policy: Policy,
  role: string,
  via: string | undefined,
): boolean {
  const kinds = bindingOf(policy, role)?.for;
  return kinds === undefined || (via !== undefined && kinds.includes(via));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * The identity provider may only hand out what the application could: a
 * declared role with `assignable: false` (an owner, a platform role) never
 * rides in on a `managedBy: 'idp'` membership. A name the policy does not
 * declare stays, because only a tenant's custom role can give it meaning.
 */
function mayHoldManaged(
  policy: Policy,
  role: string,
  membership: Membership,
): boolean {
  return (
    !isExternallyManaged(membership) ||
    bindingOf(policy, role)?.assignable !== false
  );
}

/**
 * Drops every role a membership's kind may not hold (fail-closed: a missing
 * `via` is no kind) and every non-assignable role on an identity-provider
 * membership. Global roles have no kind, so a role with `for` held globally
 * is dropped too.
 */
export function applyRoleKinds(
  policy: Policy,
  roles: readonly string[] | undefined,
  memberships: readonly Membership[],
): {
  readonly roles: readonly string[] | undefined;
  readonly memberships: readonly Membership[];
} {
  const kinds = policy.roles.some((binding) => binding.for !== undefined);
  if (!kinds && !memberships.some(isExternallyManaged)) {
    return { roles, memberships };
  }
  const kept = kinds
    ? (roles?.filter((name) => mayHoldVia(policy, name, undefined)) ?? roles)
    : roles;
  const filtered = memberships.map((membership) => {
    const allowed = membership.roles.filter(
      (name) =>
        mayHoldVia(policy, name, membership.via) &&
        mayHoldManaged(policy, name, membership),
    );
    return sameList(allowed, membership.roles)
      ? membership
      : freezeDeep({ ...membership, roles: allowed });
  });
  return { roles: kept, memberships: filtered };
}

export function usesAssigns(policy: Policy): boolean {
  return policy.roles.some((binding) => binding.assigns !== undefined);
}

/** Declared role names in declaration order: bindings first, then vocabulary-only leaves. */
function declarationOrder(policy: Policy): readonly string[] {
  const names = policy.roles.map((binding) => binding.name);
  const seen = new Set(names);
  for (const leaf of listRoles(policy.vocabulary?.roles)) {
    if (!seen.has(leaf.key)) {
      names.push(leaf.key);
      seen.add(leaf.key);
    }
  }
  return names;
}

/**
 * Each role's depth in the `assigns` graph: a role nobody else assigns is 0,
 * a role another assigns sits one below its deepest assigner. Cycles stop
 * after one pass per role.
 */
function assignDepths(policy: Policy): ReadonlyMap<string, number> {
  const names = declarationOrder(policy);
  const depth = new Map(names.map((name) => [name, 0]));
  for (let pass = 0; pass < names.length; pass += 1) {
    let changed = false;
    for (const binding of policy.roles) {
      const from = depth.get(binding.name) ?? 0;
      for (const target of binding.assigns ?? []) {
        if (target !== binding.name && (depth.get(target) ?? 0) < from + 1) {
          depth.set(target, from + 1);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return depth;
}

/**
 * `names` ordered by rank: assigners before the roles they assign, then
 * declaration order. Without an `assigns` graph the order is kept.
 */
export function rankRoles(
  policy: Policy,
  names: readonly string[],
): readonly string[] {
  if (!usesAssigns(policy)) {
    return names;
  }
  const order = declarationOrder(policy);
  const depth = assignDepths(policy);
  const index = (name: string): number => {
    const found = order.indexOf(name);
    return found === -1 ? order.length : found;
  };
  return [...names].toSorted(
    (a, b) =>
      (depth.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (depth.get(b) ?? Number.MAX_SAFE_INTEGER) || index(a) - index(b),
  );
}

/** The distinct `meta.audience` values of `names`, in rank order. */
export function audiencesOf(
  policy: Policy,
  names: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const name of rankRoles(policy, names)) {
    const audience = roleMeta(policy, name)?.audience;
    if (typeof audience === 'string' && !out.includes(audience)) {
      out.push(audience);
    }
  }
  return out;
}

/** Whether `membership` is the instance itself or one of its ancestors named in `within`. */
function coversInstance(
  membership: Membership,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  within: Readonly<Record<string, string>> | undefined,
): boolean {
  if (membership.scope === undefined || membership.id === undefined) {
    return false;
  }
  if (membership.scope === scope) {
    return membership.id === id;
  }
  const ancestors = scopeChain(scopes, scope).slice(1);
  if (!ancestors.includes(membership.scope)) {
    return false;
  }
  const wanted =
    within === undefined
      ? undefined
      : (Object.entries(within).find(
          ([key]) => resolveScope(scopes, key) === membership.scope,
        )?.[1] ?? undefined);
  return (
    wanted !== undefined && scopeIdOf(membership, membership.scope) === wanted
  );
}

/** Roles the principal holds at the instance, at an ancestor named in `within`, or globally. */
function rolesAtInstance(
  policy: Policy,
  principal: Principal,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  within: Readonly<Record<string, string>> | undefined,
  now: number,
): readonly string[] {
  const declared = declaredRoleNames(policy);
  const names = new Set<string>(
    (principal.roles ?? []).filter((name) => declared.has(name)),
  );
  for (const membership of principal.memberships ?? []) {
    if (
      !isMembershipExpired(membership, now) &&
      coversInstance(membership, scopes, scope, id, within)
    ) {
      for (const name of membership.roles) {
        names.add(name);
      }
    }
  }
  return rankRoles(policy, [...names]);
}

/** Whether the principal holds `role` on a live membership of exactly this instance. */
function holdsAt(
  principal: Principal,
  role: string,
  scope: string,
  id: string,
  now: number,
): boolean {
  return (principal.memberships ?? []).some(
    (membership) =>
      membership.scope === scope &&
      membership.id === id &&
      !isMembershipExpired(membership, now) &&
      membership.roles.includes(role),
  );
}

function conflictsWith(policy: Policy, role: string): ReadonlySet<string> {
  const out = new Set(bindingOf(policy, role)?.exclusiveWith ?? []);
  for (const binding of policy.roles) {
    if (binding.exclusiveWith?.includes(role) === true) {
      out.add(binding.name);
    }
  }
  return out;
}

/** What the change does to the instance's holder count. */
function countRules(
  binding: RoleBinding | undefined,
  role: string,
  holders: number | undefined,
  delta: -1 | 0 | 1,
  deny: (reason: Denial['reason'], detail?: unknown) => void,
): void {
  if (binding === undefined || delta === 0) {
    return;
  }
  const min = binding.min ?? 0;
  const counted =
    min > 0 || binding.max !== undefined || binding.transferOnly === true;
  if (!counted) {
    return;
  }
  const known =
    holders !== undefined && Number.isInteger(holders) && holders >= 0;
  if (!known) {
    const reason =
      delta < 0 && min > 0
        ? 'last-holder'
        : delta > 0 && binding.max !== undefined
          ? 'max-holders'
          : 'transfer-only';
    deny(reason, { role, holders: null });
    return;
  }
  const after = holders + delta;
  if (delta < 0 && min > 0 && after < min) {
    deny('last-holder', { role, min, holders });
  }
  if (delta > 0 && binding.max !== undefined && after > binding.max) {
    deny('max-holders', { role, max: binding.max, holders });
  }
  // Creating the first holder and removing the last are not transfers; `min` guards the latter.
  if (binding.transferOnly === true && holders > 0 && after > 0) {
    deny('transfer-only', { role, holders });
  }
}

export type RoleChangeOptions = {
  /**
   * `true` when the application loaded `change.within` from its own store
   * (the instance's stored parent), not from the request. Without it, a
   * nested instance's tenant comes only from a live membership the actor
   * holds on that instance or under it.
   */
  readonly trusted?: boolean;
};

/**
 * A live membership of the principal on the instance or on an instance under
 * it: the one in-band fact that ties a nested instance to a tenant.
 */
function heldAnchor(
  principal: Principal,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  now: number,
): Membership | undefined {
  return (principal.memberships ?? []).find(
    (membership) =>
      !isMembershipExpired(membership, now) &&
      membership.scope !== undefined &&
      scopeChain(scopes, membership.scope).includes(scope) &&
      scopeIdOf(membership, scope) === id &&
      tenantOf(membership, scopes) !== undefined,
  );
}

export type AssignAuthority = {
  /** Role names the ceiling (`assignableRoles`) lets the actor hand out in the instance's tenant. */
  readonly assignable: ReadonlySet<string>;
  /** The actor holds a `meta.manageRoles` role or permission there. */
  readonly manage: boolean;
};

/**
 * The one rule check behind `permdock.decideRoleChange`. The actor is always
 * the instance's own principal; nothing in `change` can stand in for it.
 */
export function decideRoleChange(
  policy: Policy,
  principal: Principal | null,
  scopes: readonly Scope[],
  change: RoleChange,
  authority: (tenant: string) => AssignAuthority,
  now: number,
  options: RoleChangeOptions = {},
): RoleChangeDecision {
  const name =
    typeof change?.role === 'string' ? change.role : change?.role?.key;
  const denials: Denial[] = [];
  const deny = (reason: Denial['reason'], detail?: unknown): void => {
    denials.push(compact<Denial>({ role: name ?? null, reason, detail }));
  };
  const done = (role: string | null): RoleChangeDecision =>
    freezeDeep(
      denials.length === 0
        ? { outcome: 'granted' as const, change, role }
        : { outcome: 'denied' as const, change, denials },
    );
  if (principal === null) {
    deny('anonymous');
    return done(null);
  }
  const kind = change?.kind;
  const target = change?.target;
  if (
    typeof name !== 'string' ||
    (kind !== 'assign' && kind !== 'revoke' && kind !== 'transfer') ||
    typeof change.id !== 'string' ||
    change.id === '' ||
    target === null ||
    typeof target !== 'object' ||
    typeof target.id !== 'string' ||
    target.id === ''
  ) {
    deny('validation');
    return done(null);
  }
  const binding = bindingOf(policy, name);
  if (!declaredRoleNames(policy).has(name)) {
    deny('unknown-role');
    return done(null);
  }
  const scope = resolveScope(scopes, change.scope);
  const on = binding?.on ?? findRole(policy.vocabulary?.roles, name)?.on;
  const heldAt = typeof on === 'string' ? resolveScope(scopes, on) : undefined;
  if (scope === undefined || heldAt === undefined || heldAt !== scope) {
    deny('scope', { expected: heldAt ?? null });
    return done(null);
  }
  const root = scopes[0]?.name;
  const supplied =
    change.within === undefined
      ? undefined
      : Object.entries(change.within).find(
          ([key]) => resolveScope(scopes, key) === root,
        )?.[1];
  let tenant: string | undefined;
  let within = change.within;
  if (scope === root) {
    tenant = change.id;
  } else {
    const anchor = heldAnchor(principal, scopes, scope, change.id, now);
    const held = anchor === undefined ? undefined : tenantOf(anchor, scopes);
    if (held !== undefined) {
      tenant = supplied === undefined || supplied === held ? held : undefined;
      within = anchor?.within;
    } else if (options.trusted === true) {
      tenant = supplied;
    }
  }
  if (tenant === undefined) {
    deny('no-membership', { scope, id: change.id });
    return done(null);
  }
  if (target.managedBy === 'idp') {
    deny('externally-managed');
    return done(null);
  }
  const self = target.id === principal.id;
  const targetRoles = isReadonlyArray(target.roles) ? target.roles : [];
  const already = targetRoles.includes(name);
  let by: string | null = null;

  if (kind === 'transfer') {
    if (self) {
      deny('self-demotion');
    }
    if (holdsAt(principal, name, scope, change.id, now)) {
      by = name;
    } else {
      deny('not-assignable-by', { holds: false });
    }
  } else {
    if (self) {
      deny(kind === 'revoke' ? 'self-demotion' : 'not-assignable-by', {
        self: true,
      });
    }
    const allowed = authority(tenant);
    if (!allowed.assignable.has(name)) {
      deny('not-assignable-by');
    } else if (usesAssigns(policy) && !allowed.manage) {
      const held = rolesAtInstance(
        policy,
        principal,
        scopes,
        scope,
        change.id,
        within,
        now,
      );
      by =
        held.find(
          (role) => bindingOf(policy, role)?.assigns?.includes(name) === true,
        ) ?? null;
      if (by === null) {
        deny('not-assignable-by', { held });
      }
    }
  }

  if (kind !== 'revoke' && !already) {
    if (!mayHoldVia(policy, name, target.via)) {
      deny('not-allowed-for-membership', {
        via: target.via ?? null,
        for: binding?.for,
      });
    }
    const conflicts = conflictsWith(policy, name);
    const clash = targetRoles.filter((role) => conflicts.has(role));
    if (clash.length > 0) {
      deny('conflicting-role', { with: clash });
    }
  }

  const delta: -1 | 0 | 1 =
    kind === 'assign'
      ? already
        ? 0
        : 1
      : kind === 'revoke'
        ? targetRoles.length > 0 && !already
          ? 0
          : -1
        : already
          ? -1
          : 0;
  countRules(binding, name, change.holders, delta, deny);
  return done(by);
}
