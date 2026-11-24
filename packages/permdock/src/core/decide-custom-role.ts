import type {
  CustomRoleDrop,
  CustomRoleRename,
  CustomRoleValidation,
} from "./custom-roles.ts";
import type { Denial } from "./decision.ts";
import type { InstanceHandle } from "./internals.ts";
import type { CustomRole } from "./subject.ts";

import { isReadonlyArray, isRecord } from "./compact.ts";
import {
  isGlobalCustomRole,
  isSharedCustomRole,
  validateCustomRole,
} from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { internalsOf } from "./internals.ts";
import { findPermission } from "./permission-registry.ts";

/**
 * `granted`: the editor may save the role as written, and `permissions` lists
 * the keys it allows after the ceiling. `denied`: `dropped` names the entries
 * the ceiling refuses, `beyond` the keys (`key@level` for a level) the editor
 * may not hand out.
 */
export type CustomRoleDecision =
  | {
      readonly outcome: "granted";
      readonly role: CustomRole;
      readonly permissions: readonly string[];
      readonly renamed: readonly CustomRoleRename[];
    }
  | {
      readonly outcome: "denied";
      readonly role: CustomRole;
      readonly denials: readonly Denial[];
      readonly dropped: readonly CustomRoleDrop[];
      readonly beyond: readonly string[];
    };

function wellFormed(role: unknown): role is CustomRole {
  if (!isRecord(role)) {
    return false;
  }
  const { name, grants, includes, shared, scope, tenant } = role;
  return (
    typeof name === "string" &&
    name !== "" &&
    [grants, includes].every(
      (list) => list === undefined || isReadonlyArray(list),
    ) &&
    (shared === true ||
      scope === "global" ||
      (typeof tenant === "string" && tenant !== ""))
  );
}

/** The own allows that name a level, as `key@level`. */
function leveledAllows(
  role: CustomRole,
  validation: CustomRoleValidation,
): readonly (readonly [string, string])[] {
  const renamed = new Map(
    validation.renamed.map((item) => [item.from, item.to]),
  );
  const out: [string, string][] = [];
  for (const grant of role.grants ?? []) {
    if (
      isRecord(grant) &&
      typeof grant.permission === "string" &&
      typeof grant.level === "string" &&
      grant.effect !== "deny"
    ) {
      out.push([
        renamed.get(grant.permission) ?? grant.permission,
        grant.level,
      ]);
    }
  }
  return out;
}

/**
 * Whether the subject of `permdock` may save `role` as a tenant or platform
 * custom role: every entry resolves inside the ceiling (`validateCustomRole`,
 * with the shared roles the instance read), and every key and level it allows
 * is one the subject may hand out (`assignablePermissions`,
 * `assignableLevels`). A subject offered nothing at the role's scope is denied
 * even an empty role. It never writes and never throws; a shared role, an
 * instance built from a snapshot or malformed input is denied.
 */
export function decideCustomRole(
  permdock: InstanceHandle,
  role: CustomRole,
): CustomRoleDecision {
  const name =
    isRecord(role) && typeof role.name === "string" ? role.name : null;
  const denied = (
    reason: Denial["reason"],
    rest: {
      readonly detail?: unknown;
      readonly dropped?: readonly CustomRoleDrop[];
      readonly beyond?: readonly string[];
    } = {},
  ): CustomRoleDecision =>
    freezeDeep({
      outcome: "denied" as const,
      role,
      denials: [
        rest.detail === undefined
          ? { role: name, reason }
          : { role: name, reason, detail: rest.detail },
      ],
      dropped: rest.dropped ?? [],
      beyond: rest.beyond ?? [],
    });
  const internals = internalsOf(permdock);
  if (internals === undefined) {
    return denied("unsupported");
  }
  const { instance, policy, subject } = internals;
  if (subject.principal === null) {
    return denied("anonymous");
  }
  if (!wellFormed(role)) {
    return denied("validation");
  }
  if (isSharedCustomRole(role)) {
    return denied("unsupported");
  }
  const validation = validateCustomRole(policy, role, {
    shared: internals.env.customRoles.filter(isSharedCustomRole),
  });
  if (!validation.ok) {
    return denied("validation", { dropped: validation.dropped });
  }
  const at = isGlobalCustomRole(role)
    ? ({ scope: "global" } as const)
    : { tenant: role.tenant ?? "" };
  const offered = new Set(
    instance.assignablePermissions(at).map((leaf) => leaf.key),
  );
  if (offered.size === 0) {
    return denied("not-assignable-by", { detail: { offered: [] } });
  }
  const beyond = validation.permissions.filter((key) => !offered.has(key));
  for (const [key, level] of leveledAllows(role, validation)) {
    const leaf = findPermission(policy.permissions, key);
    if (
      offered.has(key) &&
      (leaf === undefined ||
        !instance.assignableLevels(leaf, at).includes(level))
    ) {
      beyond.push(`${key}@${level}`);
    }
  }
  if (beyond.length > 0) {
    const sorted = [...new Set(beyond)].toSorted();
    return denied("not-assignable-by", {
      detail: { beyond: sorted },
      beyond: sorted,
    });
  }
  return freezeDeep({
    outcome: "granted" as const,
    role,
    permissions: validation.permissions,
    renamed: validation.renamed,
  });
}
