import type { Condition } from "../conditions/ast.ts";
import type { RoleGrantee } from "./grantee.ts";
import type { Grant, Policy } from "./policy.ts";
import type { CustomRole, CustomRoleGrant, Membership } from "./subject.ts";

import { freezeDeep } from "./freeze.ts";
import { flattenGrantee } from "./grantee.ts";
import { isForbiddenKey } from "./paths.ts";
import { findPermission, formerKeys } from "./permissions.ts";
import { declaredRoleNames, grantList, levelCondition } from "./policy.ts";
import {
  type Scope,
  normalizeMemberships,
  resolveScope,
  scopeList,
  tenantOf,
} from "./scopes.ts";
import { findRole } from "./vocabulary.ts";

export type CustomRoleDropReason =
  | "unknown-permission"
  | "outside-ceiling"
  | "condition-not-allowed"
  | "unknown-level";

/** Why part of a custom role was left out: a permission, or an undeclared include. */
export type CustomRoleDrop =
  | {
      readonly permission: string;
      readonly reason: CustomRoleDropReason;
      /** The stored level, for `unknown-level`. */
      readonly level?: string;
    }
  | { readonly role: string; readonly reason: "unknown-role" };

/** A stored grant that named a permission by a key it was renamed from. */
export type CustomRoleRename = {
  readonly from: string;
  readonly to: string;
};

export type ResolvedCustomRole = {
  /** Declared grants re-targeted to the custom role; conditions and approvals kept. */
  readonly grants: readonly Grant[];
  readonly dropped: readonly CustomRoleDrop[];
  /** Grants stored under a former key (`definePermissions` `renamed`), resolved to the current one. */
  readonly renamed: readonly CustomRoleRename[];
};

export type CustomRoleValidation = {
  readonly ok: boolean;
  /** Permission keys the role allows after the ceiling, sorted. */
  readonly permissions: readonly string[];
  readonly dropped: readonly CustomRoleDrop[];
  /** Grants to rewrite in storage: each still resolves, under its current key. */
  readonly renamed: readonly CustomRoleRename[];
};

/** The current key for a stored key, current or former; `undefined` when neither. */
function currentKey(policy: Policy, raw: string): string | undefined {
  const leaf = findPermission(policy.permissions, raw);
  if (leaf === undefined) {
    return undefined;
  }
  return leaf.key === raw || formerKeys(leaf).includes(raw)
    ? leaf.key
    : undefined;
}

/** A resolved custom-role grant and the role it belongs to. */
export type CustomGrant = {
  readonly grant: Grant;
  readonly role: CustomRole;
};

const GRANT_KEYS = new Set(["permission", "effect", "level"]);

/** Every level of a permission an own allow reaches: `'all'` for an allow without a level. */
type AllowLevels = "all" | Map<string, Condition>;

/** `where` narrowed by a level; the empty level (`{}`) leaves it as is. */
export function andWhere(
  where: Condition | undefined,
  level: Condition,
): Condition | undefined {
  if (level.op === "and" && level.conditions.length === 0) {
    return where;
  }
  return where === undefined
    ? level
    : { op: "and", conditions: [where, level] };
}

/** A ceiling grant narrowed by a level's condition and marked with the level. */
export function leveled(
  grant: Grant,
  level: string,
  condition: Condition,
): Grant {
  const where = andWhere(grant.where, condition);
  const check =
    grant.check === undefined ? undefined : andWhere(grant.check, condition);
  return freezeDeep({
    ...grant,
    level,
    ...(where === undefined ? {} : { where }),
    ...(check === undefined ? {} : { check }),
  });
}

/** The named scope a custom-role ceiling is keyed by. */
export type CeilingScope = string;

/**
 * The scope a custom role is held at: `scope` (a name or alias), the second
 * scope for the `team` input shape, else the first scope. `undefined` when
 * the policy does not declare it; such a role resolves to nothing.
 */
export function customRoleScope(
  role: Pick<CustomRole, "scope" | "team">,
  scopes: readonly Scope[],
): CeilingScope | undefined {
  if (role.scope === "global") {
    return "global";
  }
  if (role.scope !== undefined) {
    return resolveScope(scopes, role.scope);
  }
  return resolveScope(scopes, role.team === undefined ? "tenant" : "team");
}

/** The instance of its scope a custom role is pinned to, if any. */
export function customRoleId(role: CustomRole): string | undefined {
  return role.scope === undefined ? role.team : role.id;
}

/** A platform custom role: held through `principal.roles`, capped by the assignable global roles. */
export function isGlobalCustomRole(role: CustomRole): boolean {
  return role.scope === "global";
}

function isCeilingScope(scope: Grant["scope"]): scope is CeilingScope {
  return typeof scope === "string";
}

function soleRole(grant: Grant): string | undefined {
  const roles = flattenGrantee(grant.to).filter((item) => item.kind === "role");
  const first = roles[0];
  return roles.length === 1 && first?.kind === "role" ? first.role : undefined;
}

/** Permission keys a declared role's allows reach, hosted grants included. */
export function roleAllowKeys(
  policy: Policy,
  name: string,
): ReadonlySet<string> {
  return new Set(
    grantList(policy)
      .filter((grant) => grant.effect === "allow" && soleRole(grant) === name)
      .map((grant) => grant.permission.key),
  );
}

function isAssignableRole(policy: Policy, name: string): boolean {
  const binding = policy.rolesByName.get(name);
  if (binding !== undefined) {
    return binding.assignable;
  }
  return findRole(policy.vocabulary?.roles, name)?.assignable === true;
}

/**
 * Every scope's ceiling, keyed by scope name (`global` for platform custom
 * roles): the code allows of declared `assignable` roles in that scope,
 * everything a custom role of the scope may ever reach. Hosted grants never
 * widen it. `assignable` narrows it to those role names (`RoleSource.assignable`).
 */
function ceilings(
  policy: Policy,
  assignable?: readonly string[],
): ReadonlyMap<CeilingScope, readonly Grant[]> {
  const allowed = assignable === undefined ? undefined : new Set(assignable);
  const byScope = new Map<CeilingScope, Grant[]>();
  for (const grant of grantList(policy)) {
    const name = soleRole(grant);
    if (
      grant.effect !== "allow" ||
      grant.hosted !== undefined ||
      !isCeilingScope(grant.scope) ||
      name === undefined ||
      !isAssignableRole(policy, name) ||
      (allowed !== undefined && !allowed.has(name))
    ) {
      continue;
    }
    const list = byScope.get(grant.scope) ?? [];
    list.push(grant);
    byScope.set(grant.scope, list);
  }
  return byScope;
}

export function ceilingGrants(
  policy: Policy,
  scope: CeilingScope,
  assignable?: readonly string[],
): readonly Grant[] {
  return ceilings(policy, assignable).get(scope) ?? [];
}

function retarget(grant: Grant, role: CustomRole, scope: CeilingScope): Grant {
  const grantee: RoleGrantee = { kind: "role", role: role.name, scope };
  const others = flattenGrantee(grant.to).filter(
    (item) => item.kind !== "role",
  );
  return freezeDeep({
    ...grant,
    to: others.length === 0 ? grantee : [grantee, ...others],
    role: role.name,
    scope,
  });
}

/**
 * The one resolver behind evaluation, snapshots and `validateCustomRole`.
 * Included roles' grants plus the role's own allows, minus its denies, all
 * intersected with the ceiling. An allow inherits the condition, approval and
 * limit of the declared grant it comes from: an included assignable role's
 * grant when there is one, otherwise every ceiling grant of that permission,
 * together with the denies of the roles those grants belong to.
 */
export function resolveCustomRole(
  policy: Policy,
  role: CustomRole,
): ResolvedCustomRole {
  const scope = customRoleScope(role, scopeList(policy.scopes));
  if (scope === undefined) {
    return freezeDeep({ grants: [], dropped: [], renamed: [] });
  }
  const ceiling = ceilingGrants(policy, scope);
  const ceilingSet = new Set(ceiling);
  const ceilingKeys = new Set(ceiling.map((grant) => grant.permission.key));
  const declared = declaredRoleNames(policy);
  const all = grantList(policy).filter((grant) => grant.hosted === undefined);
  const dropped: CustomRoleDrop[] = [];
  const renamed: CustomRoleRename[] = [];
  const seen = new Set<string>();
  const drop = (entry: CustomRoleDrop): void => {
    const id =
      "role" in entry
        ? `role:${entry.role}`
        : `${entry.reason}:${entry.permission}`;
    if (!seen.has(id)) {
      seen.add(id);
      dropped.push(entry);
    }
  };

  const included: Grant[] = [];
  const includedKeys = new Set<string>();
  const allowKeys = new Map<string, AllowLevels>();
  const denyKeys = new Set<string>();
  const allowAll = (key: string): void => {
    allowKeys.set(key, "all");
  };

  for (const name of Array.isArray(role.includes) ? role.includes : []) {
    if (typeof name !== "string" || !declared.has(name)) {
      drop({ role: String(name), reason: "unknown-role" });
      continue;
    }
    for (const grant of all) {
      if (soleRole(grant) !== name) {
        continue;
      }
      const key = grant.permission.key;
      if (grant.effect === "deny") {
        // Only denies of the role's own scope: RLS evaluates each scope's keys separately.
        if (grant.scope === scope) {
          included.push(grant);
        }
      } else if (ceilingSet.has(grant)) {
        included.push(grant);
        includedKeys.add(key);
      } else if (ceilingKeys.has(key)) {
        allowAll(key);
      } else {
        drop({ permission: key, reason: "outside-ceiling" });
      }
    }
  }

  const entries: readonly unknown[] = Array.isArray(role.grants)
    ? role.grants
    : [];
  for (const item of entries) {
    if (item === null || typeof item !== "object") {
      drop({ permission: String(item), reason: "unknown-permission" });
      continue;
    }
    // SAFETY: item is a non-null object checked above; every field stays unknown until checked.
    const entry = item as {
      readonly permission?: unknown;
      readonly effect?: unknown;
      readonly level?: unknown;
    };
    const raw = entry.permission;
    const key = typeof raw === "string" ? currentKey(policy, raw) : undefined;
    if (key === undefined) {
      drop({ permission: String(raw), reason: "unknown-permission" });
      continue;
    }
    if (key !== raw) {
      renamed.push({ from: String(raw), to: key });
    }
    const effect = entry.effect ?? "allow";
    const extra = Object.keys(entry).some((name) => !GRANT_KEYS.has(name));
    const level = entry.level;
    if (
      extra ||
      (effect !== "allow" && effect !== "deny") ||
      (effect === "deny" && level !== undefined)
    ) {
      drop({ permission: key, reason: "condition-not-allowed" });
      // A malformed entry can only narrow: it still removes the permission.
      denyKeys.add(key);
      continue;
    }
    if (effect === "deny") {
      denyKeys.add(key);
      continue;
    }
    let narrowing: readonly [string, Condition] | undefined;
    if (level !== undefined) {
      const leaf = findPermission(policy.permissions, key);
      const condition =
        typeof level === "string" && leaf?.kind === "instance"
          ? levelCondition(policy, leaf.resource, level)
          : undefined;
      if (condition === undefined) {
        drop({
          permission: key,
          reason: "unknown-level",
          level: String(level),
        });
        // An unknown level never falls back to the wider grant.
        denyKeys.add(key);
        continue;
      }
      narrowing = [String(level), condition];
    }
    if (!ceilingKeys.has(key)) {
      drop({ permission: key, reason: "outside-ceiling" });
      continue;
    }
    const held = allowKeys.get(key);
    if (narrowing === undefined) {
      allowAll(key);
    } else if (held === undefined) {
      allowKeys.set(key, new Map([narrowing]));
    } else if (held !== "all") {
      held.set(...narrowing);
    }
  }

  const out: Grant[] = [];
  const push = (grant: Grant): void => {
    if (!out.includes(grant)) {
      out.push(grant);
    }
  };
  for (const grant of included) {
    if (grant.effect === "deny" || !denyKeys.has(grant.permission.key)) {
      push(grant);
    }
  }
  for (const [key, levels] of allowKeys) {
    if (denyKeys.has(key) || includedKeys.has(key)) {
      continue;
    }
    const sources = new Set<string>();
    for (const grant of ceiling) {
      if (grant.permission.key !== key) {
        continue;
      }
      sources.add(soleRole(grant) ?? "");
      if (levels === "all") {
        push(grant);
        continue;
      }
      for (const [level, condition] of levels) {
        push(leveled(grant, level, condition));
      }
    }
    for (const grant of all) {
      if (
        grant.effect === "deny" &&
        grant.permission.key === key &&
        sources.has(soleRole(grant) ?? "")
      ) {
        push(grant);
      }
    }
  }
  return freezeDeep({
    grants: out.map((grant) => retarget(grant, role, scope)),
    dropped,
    renamed,
  });
}

export function validateCustomRole(
  policy: Policy,
  role: CustomRole,
): CustomRoleValidation {
  const resolved = resolveCustomRole(policy, role);
  const permissions = [
    ...new Set(
      resolved.grants
        .filter((grant) => grant.effect === "allow")
        .map((grant) => grant.permission.key),
    ),
  ].toSorted();
  return freezeDeep({
    ok: resolved.dropped.length === 0,
    permissions,
    dropped: resolved.dropped,
    renamed: resolved.renamed,
  });
}

function wellFormed(role: CustomRole): boolean {
  if (
    role === null ||
    typeof role !== "object" ||
    typeof role.name !== "string"
  ) {
    return false;
  }
  if (role.scope === "global") {
    // A tenant, team or id on a platform role is a mistake, not a narrowing to trust.
    return (
      role.tenant === undefined &&
      role.team === undefined &&
      role.id === undefined
    );
  }
  return (
    typeof role.tenant === "string" &&
    (role.team === undefined || typeof role.team === "string") &&
    (role.scope === undefined || typeof role.scope === "string") &&
    (role.id === undefined || typeof role.id === "string")
  );
}

/** Every custom role's resolved grants, once per instance. Malformed roles resolve to nothing. */
export function customGrantsFor(
  policy: Policy,
  roles: readonly CustomRole[],
): readonly CustomGrant[] {
  const declared = declaredRoleNames(policy);
  const out: CustomGrant[] = [];
  for (const role of roles) {
    if (!wellFormed(role) || declared.has(role.name)) {
      continue;
    }
    for (const grant of resolveCustomRole(policy, role).grants) {
      out.push({ grant, role });
    }
  }
  return out;
}

/** The well-formed tenant (not platform) custom roles; a declared role name is never one. */
export function tenantCustomRoles(
  policy: Policy,
  roles: readonly CustomRole[],
): readonly CustomRole[] {
  const declared = declaredRoleNames(policy);
  return roles.filter(
    (role) =>
      wellFormed(role) && !isGlobalCustomRole(role) && !declared.has(role.name),
  );
}

/** A membership at the role's scope, inside its tenant (and instance, when pinned), naming it. */
export function holdsCustomRole(
  membership: Membership,
  role: CustomRole,
  scopes: readonly Scope[],
): boolean {
  if (isGlobalCustomRole(role)) {
    return false;
  }
  const scope = customRoleScope(role, scopes);
  const id = customRoleId(role);
  return (
    scope !== undefined &&
    membership.scope === scope &&
    tenantOf(membership, scopes) === role.tenant &&
    (id === undefined || membership.id === id) &&
    membership.roles.includes(role.name)
  );
}

/** Whether `principal.roles` names the platform custom role. */
export function holdsGlobalCustomRole(
  roles: readonly string[] | undefined,
  role: CustomRole,
): boolean {
  return isGlobalCustomRole(role) && (roles ?? []).includes(role.name);
}

/** A tenant's custom role inside that tenant, or a platform custom role anywhere. */
export function isCustomRoleName(
  name: string,
  roles: readonly CustomRole[],
  tenant: string | undefined,
): boolean {
  return roles.some(
    (item) =>
      wellFormed(item) &&
      item.name === name &&
      (isGlobalCustomRole(item) ||
        (tenant !== undefined && item.tenant === tenant)),
  );
}

/**
 * The compact JWT form of custom roles for the `memberships[].grants` claim
 * RLS reads in `jwt` mode: role name to entries, where `key` allows, `-key`
 * denies and `@role` includes. Put a team custom role on its team membership.
 * Pass `policy` to write keys stored under a former name as the current key.
 */
export function customRoleClaim(
  roles: readonly CustomRole[],
  policy?: Policy,
): Readonly<Record<string, readonly string[]>> {
  const keyOf = (raw: string): string =>
    policy === undefined ? raw : (currentKey(policy, raw) ?? raw);
  const claim: Record<string, string[]> = {};
  for (const role of roles) {
    if (!wellFormed(role) || isForbiddenKey(role.name)) {
      continue;
    }
    const entries = claim[role.name] ?? [];
    const includes: readonly string[] = Array.isArray(role.includes)
      ? role.includes
      : [];
    const grants: readonly CustomRoleGrant[] = Array.isArray(role.grants)
      ? role.grants
      : [];
    for (const name of includes) {
      entries.push(`@${name}`);
    }
    for (const grant of grants) {
      if (grant.effect === "deny") {
        entries.push(`-${keyOf(grant.permission)}`);
        continue;
      }
      const level = grant.level;
      entries.push(
        typeof level === "string" && level !== ""
          ? `${keyOf(grant.permission)}@${level}`
          : keyOf(grant.permission),
      );
    }
    claim[role.name] = entries;
  }
  return freezeDeep(claim);
}

/**
 * The `memberships` claim RLS reads in `jwt` mode: each membership canonical,
 * with the custom roles it holds as the compact `grants` map.
 */
export function membershipsClaim(
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): readonly Readonly<Record<string, unknown>>[] {
  const claim: Readonly<Record<string, unknown>>[] = [];
  for (const membership of normalizeMemberships(memberships, scopes)) {
    const held = customRoles.filter(
      (role) => wellFormed(role) && holdsCustomRole(membership, role, scopes),
    );
    claim.push(
      held.length === 0
        ? membership
        : Object.assign({}, membership, { grants: customRoleClaim(held) }),
    );
  }
  return claim;
}
