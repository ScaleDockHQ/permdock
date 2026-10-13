import type { Permission } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { CustomRole, Principal, Subject } from "./subject.ts";

import { canonicalJson } from "./canonical-json.ts";
import { compact } from "./compact.ts";
import {
  type CustomGrant,
  ceilingGrants,
  customRoleScope,
  resolveCustomRole,
  roleAllowKeys,
  tenantCustomRoles,
} from "./custom-roles.ts";
import { evaluate } from "./evaluate.ts";
import { type EvalEnv, emptyListeners } from "./events.ts";
import { freezeDeep } from "./freeze.ts";
import { heldRoleNames, roleLeaf } from "./held-roles.ts";
import { rankRoles, roleMeta, usesAssigns } from "./ownership.ts";
import { listPermissions } from "./permission-registry.ts";
import { levelCondition, levelNames } from "./policy.ts";
import { resolveScope, rootScope, scopeList, tenantOf } from "./scopes.ts";
import { collectSnapshotGrants } from "./snapshot-grants.ts";
import {
  isMembershipExpired,
  nowSeconds,
  resolveActiveTenant,
} from "./tenancy.ts";
import {
  type Role,
  listRoles,
  sourceRoleMeta,
  synthesiseRole,
  treeXSchema,
} from "./vocabulary.ts";

/**
 * Declared roles a tenant admin may hand out or compose, before any
 * intersection: `assignable` roles, plus every role some `assigns` lists.
 */
function assignableCandidates(policy: Policy): readonly Role[] {
  const listed = new Set(
    policy.roles.flatMap((binding) => binding.assigns ?? []),
  );
  const names = [
    ...listRoles(policy.vocabulary?.roles)
      .filter((leaf) => leaf.assignable || listed.has(leaf.key))
      .map((leaf) => leaf.key),
    ...policy.roles
      .filter((binding) => binding.assignable || listed.has(binding.name))
      .map((binding) => binding.name),
  ];
  return rankRoles(policy, [...new Set(names)]).map((name) =>
    roleLeaf(policy, name),
  );
}

export type Assignable = {
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  /** Per assignable permission key with levels, the levels the subject may hand out. */
  readonly levels: Readonly<Record<string, readonly string[]>>;
  /** A `meta.manageRoles` role or permission lifted the intersection. */
  readonly manage: boolean;
  /** Custom roles held at a scope the subject assigns at that allow nothing: never offered, still revocable. */
  readonly inert: readonly string[];
};

/**
 * The levels a held allow of a permission covers: its own `level`, every
 * level when it has no row condition, or the levels whose condition equals
 * its condition.
 */
function heldLevels(
  policy: Policy,
  grant: Grant,
  names: readonly string[],
): readonly string[] {
  if (grant.level !== undefined) {
    return [grant.level];
  }
  if (grant.where === undefined) {
    return names;
  }
  const held = canonicalJson(grant.where);
  return names.filter((name) => {
    const condition = levelCondition(policy, grant.permission.resource, name);
    return condition !== undefined && canonicalJson(condition) === held;
  });
}

/**
 * What the subject may hand out in `tenant`: declared assignable roles and the
 * tenant custom-role ceiling, narrowed by `allowed` (`CustomRoleSource.assignable`),
 * then intersected with the permissions the subject holds there. Holding a
 * role or a granted permission with `meta.manageRoles` lifts the intersection.
 */
export function assignableIn(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  customGrants: readonly CustomGrant[],
  tenant: string | undefined,
  allowed: readonly string[] | undefined,
  now: number = nowSeconds(),
  global = false,
): Assignable {
  const principal = subject.principal;
  if (principal === null) {
    return { roles: [], permissions: [], levels: {}, manage: false, inert: [] };
  }
  const scopes = scopeList(policy.scopes);
  const scoped: Subject =
    tenant === undefined
      ? subject
      : freezeDeep(
          compact<Subject>({
            ...subject,
            principal: compact<Principal>({
              ...principal,
              tenant: resolveActiveTenant(principal, tenant, scopes, now),
            }),
          }),
        );
  const heldGrants = collectSnapshotGrants(
    policy,
    scoped,
    customRoles,
    now,
    customGrants,
  )
    .filter(
      (item) =>
        item.grant.effect === "allow" &&
        (item.membership === undefined ||
          (!global &&
            tenantOf(item.membership, scopes) === tenant &&
            !isMembershipExpired(item.membership, now))),
    )
    .map((item) => item.grant);
  const heldKeys = new Set(heldGrants.map((grant) => grant.permission.key));
  const heldNames = heldRoleNames(policy, subject, tenant, undefined, now);
  const quiet: EvalEnv = {
    emit: false,
    simulated: true,
    skipAlternatives: true,
    customRoles,
    customGrants,
    listeners: emptyListeners(),
    sink: undefined,
    limits: undefined,
    limitCache: new Map(),
    team: undefined,
  };
  const manage =
    heldNames.some((name) => roleMeta(policy, name)?.manageRoles === true) ||
    listPermissions(policy.permissions).some(
      (leaf) =>
        leaf.meta.manageRoles === true &&
        evaluate(
          policy,
          scoped,
          leaf,
          undefined,
          { call: "simulate", trusted: true, now },
          quiet,
        ).outcome === "granted",
    );
  const narrowed = allowed === undefined ? undefined : new Set<string>(allowed);
  const candidates = assignableCandidates(policy).filter(
    (leaf) => narrowed === undefined || narrowed.has(leaf.key),
  );
  const held = new Set(heldNames);
  // An `assigns` graph is authoritative: held roles hand out exactly what they list.
  const listed = usesAssigns(policy)
    ? new Set(
        heldNames.flatMap(
          (name) => policy.rolesByName.get(name)?.assigns ?? [],
        ),
      )
    : undefined;
  const roles = manage
    ? candidates
    : candidates.filter((leaf) => {
        if (listed !== undefined) {
          return listed.has(leaf.key);
        }
        if (held.has(leaf.key)) {
          return true;
        }
        // A role with no allows yet may gain hosted grants later: only its holders assign it.
        const keys = [...roleAllowKeys(policy, leaf.key)];
        return keys.length > 0 && keys.every((key) => heldKeys.has(key));
      });
  const root = global ? "global" : rootScope(scopes);
  const ceiling = new Set(
    (root === undefined ? [] : ceilingGrants(policy, root, allowed)).map(
      (grant) => grant.permission.key,
    ),
  );
  const permissions = listPermissions(policy.permissions).filter(
    (leaf) => ceiling.has(leaf.key) && (manage || heldKeys.has(leaf.key)),
  );
  const offeredLevels = (
    key: string,
    names: readonly string[],
  ): readonly string[] => {
    if (manage) {
      return names;
    }
    const reached = new Set(
      heldGrants
        .filter((grant) => grant.permission.key === key)
        .flatMap((grant) => heldLevels(policy, grant, names)),
    );
    return names.filter((name) => reached.has(name));
  };
  const levels: Record<string, readonly string[]> = {};
  for (const leaf of permissions) {
    const names =
      leaf.kind === "instance" ? levelNames(policy, leaf.resource) : [];
    if (names.length > 0) {
      levels[leaf.key] = offeredLevels(leaf.key, names);
    }
  }
  const ceilingKeys = new Map<string, ReadonlySet<string>>();
  const mayHandOut = (scope: string, grant: Grant): boolean => {
    const key = grant.permission.key;
    let keys = ceilingKeys.get(scope);
    if (keys === undefined) {
      keys = new Set(
        ceilingGrants(policy, scope, allowed).map(
          (item) => item.permission.key,
        ),
      );
      ceilingKeys.set(scope, keys);
    }
    if (!keys.has(key) || !(manage || heldKeys.has(key))) {
      return false;
    }
    const names =
      grant.permission.kind === "instance"
        ? levelNames(policy, grant.permission.resource)
        : [];
    if (names.length === 0) {
      return true;
    }
    const offered = offeredLevels(key, names);
    return heldLevels(policy, grant, names).every((name) =>
      offered.includes(name),
    );
  };
  const custom =
    global || tenant === undefined
      ? { roles: [], inert: [] }
      : assignableCustomRoles(
          policy,
          customRoles,
          tenant,
          manage ? undefined : roles,
          mayHandOut,
        );
  return {
    roles: [...roles, ...custom.roles],
    permissions,
    levels,
    manage,
    inert: custom.inert,
  };
}

/**
 * The tenant's custom roles the subject may hand out: held at a scope it may
 * assign declared roles at (any scope with `meta.manageRoles`), allowing at
 * least one permission after the ceiling, and only permissions and levels it
 * may hand out at that scope. A role that allows nothing is `inert`.
 */
function assignableCustomRoles(
  policy: Policy,
  customRoles: readonly CustomRole[],
  tenant: string,
  declared: readonly Role[] | undefined,
  mayHandOut: (scope: string, grant: Grant) => boolean,
): { readonly roles: readonly Role[]; readonly inert: readonly string[] } {
  const scopes = scopeList(policy.scopes);
  const root = rootScope(scopes);
  const assignsAt =
    declared === undefined
      ? undefined
      : new Set(
          declared.map((leaf) =>
            leaf.on === undefined ? root : resolveScope(scopes, leaf.on),
          ),
        );
  const out = new Map<string, Role>();
  const inert = new Set<string>();
  for (const role of tenantCustomRoles(policy, customRoles)) {
    if (role.tenant !== tenant || out.has(role.name)) {
      continue;
    }
    const at = customRoleScope(role, scopes);
    if (at === undefined || (assignsAt !== undefined && !assignsAt.has(at))) {
      continue;
    }
    const { grants } = resolveCustomRole(policy, role);
    if (!grants.some((grant) => grant.effect === "allow")) {
      inert.add(role.name);
      continue;
    }
    const within = grants.every(
      (grant) => grant.effect === "deny" || mayHandOut(at, grant),
    );
    if (within) {
      out.set(
        role.name,
        synthesiseRole(
          role.name,
          compact({
            on: at,
            assignable: true,
            meta: sourceRoleMeta(
              role.meta,
              treeXSchema(policy.vocabulary?.roles),
            ),
          }),
        ),
      );
    }
  }
  return {
    roles: [...out.values()].toSorted((a, b) => a.key.localeCompare(b.key)),
    inert: [...inert].filter((name) => !out.has(name)).toSorted(),
  };
}
