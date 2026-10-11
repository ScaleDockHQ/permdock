import type { Condition } from "../conditions/ast.ts";
import type { ResourceNode } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { CustomRole, Membership, Subject } from "./subject.ts";

import { sole } from "./compact.ts";
import {
  type CustomGrant,
  holdsCustomRole,
  holdsGlobalCustomRole,
} from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { combineWhere } from "./grantee-match.ts";
import { flattenGrantee } from "./grantee.ts";
import { declaredRoleNames } from "./policy.ts";
import { expandRoleNames } from "./role-loading.ts";
import { keepsPermission, scopeList, tenantOf } from "./scopes.ts";
import { isMembershipExpired, partitionsOf, scopeField } from "./tenancy.ts";
import { isActive } from "./validity.ts";

const NEVER: Condition = freezeDeep({ op: "or", conditions: [] });

function isUnconditionedAllow(grant: Grant, now: number): boolean {
  return (
    grant.where === undefined &&
    grant.check === undefined &&
    grant.closure === undefined &&
    grant.portable &&
    grant.purpose === undefined &&
    grant.viaOnly === undefined &&
    grant.requires === undefined &&
    isActive(grant.validity, now)
  );
}

/**
 * The row condition a grant's `requires` adds: the row's instance of some
 * scope is one where the subject holds `key` through a role grant without a
 * row condition, minus the instances a deny of `key` reaches at that scope.
 * `undefined` when the subject holds `key` globally that way, so every row
 * passes. The in-process mirror of the SQL `permdock_has_permission` and
 * `permitted_<scope>_ids_by_permission`.
 */
export function requirementCondition(
  policy: Policy,
  subject: Subject,
  keys: readonly string[],
  resource: ResourceNode | undefined,
  now: number,
  customRoles: readonly CustomRole[],
  customGrants: readonly CustomGrant[],
): Condition | undefined {
  let where: Condition | undefined;
  for (const key of keys) {
    where = combineWhere(
      where,
      keyRequirement(
        policy,
        subject,
        key,
        resource,
        now,
        customRoles,
        customGrants,
      ),
    );
  }
  return where;
}

function keyRequirement(
  policy: Policy,
  subject: Subject,
  key: string,
  resource: ResourceNode | undefined,
  now: number,
  customRoles: readonly CustomRole[],
  customGrants: readonly CustomGrant[],
): Condition | undefined {
  const principal = subject.principal;
  if (principal === null) {
    return NEVER;
  }
  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const global = new Set(
    expandRoleNames(
      principal.roles ?? [],
      declared,
      customRoles,
      principal.tenant,
    ).roles,
  );
  const held = (principal.memberships ?? [])
    .filter(
      (membership) =>
        !isMembershipExpired(membership, now) &&
        keepsPermission(membership, key),
    )
    .map((membership) => ({
      membership,
      roles: new Set(
        expandRoleNames(
          membership.roles,
          declared,
          customRoles,
          tenantOf(membership, scopes),
        ).roles,
      ),
    }));
  const allowed = new Map<string, Set<string>>();
  const denied = new Map<string, Set<string>>();
  let globalAllow = false;
  let globalDeny = false;
  const note = (effect: Grant["effect"], membership?: Membership): void => {
    if (membership === undefined) {
      if (effect === "allow") {
        globalAllow = true;
      } else {
        globalDeny = true;
      }
      return;
    }
    if (membership.scope === undefined || membership.id === undefined) {
      return;
    }
    const target = effect === "allow" ? allowed : denied;
    const ids = target.get(membership.scope) ?? new Set<string>();
    ids.add(membership.id);
    target.set(membership.scope, ids);
  };
  const applies = (grant: Grant): boolean =>
    grant.effect === "allow"
      ? isUnconditionedAllow(grant, now)
      : isActive(grant.validity, now);
  for (const grant of policy.index.grantsByKey.get(key) ?? []) {
    const items = flattenGrantee(grant.to);
    if (
      grant.breakGlass !== undefined ||
      !applies(grant) ||
      items.length === 0 ||
      !items.every((item) => item.kind === "role")
    ) {
      continue;
    }
    const roles = items.flatMap((item) => (item.kind === "role" ? [item] : []));
    if (
      !roles.every((item) => item.scope !== "global" || global.has(item.role))
    ) {
      continue;
    }
    const scoped = roles.filter((item) => item.scope !== "global");
    if (scoped.length === 0) {
      note(grant.effect);
      continue;
    }
    for (const entry of held) {
      if (
        scoped.every(
          (item) =>
            typeof item.scope === "string" &&
            entry.membership.scope === item.scope &&
            entry.roles.has(item.role),
        )
      ) {
        note(grant.effect, entry.membership);
      }
    }
  }
  for (const { grant, role } of customGrants) {
    if (grant.permission.key !== key || !applies(grant)) {
      continue;
    }
    if (holdsGlobalCustomRole(principal.roles, role)) {
      note(grant.effect);
    }
    for (const entry of held) {
      if (holdsCustomRole(entry.membership, role, scopes)) {
        note(grant.effect, entry.membership);
      }
    }
  }
  if (globalAllow && !globalDeny) {
    return undefined;
  }
  const parts: Condition[] = [];
  for (const name of resource === undefined
    ? []
    : partitionsOf(resource, scopes)) {
    const field = scopeField(resource, name, scopes);
    const deniedIds = denied.get(name);
    const ids = [...(allowed.get(name) ?? [])]
      .filter((id) => deniedIds?.has(id) !== true)
      .toSorted();
    if (field !== undefined && ids.length > 0) {
      parts.push({ op: "in", field, value: ids });
    }
  }
  return sole(parts) ?? { op: "or", conditions: parts };
}
