import type {
  LocalAssignable,
  LocalCustomRoleTable,
  SnapshotAssignable,
  SnapshotGrant,
} from "../core/snapshot-types.ts";

import { compact } from "../core/compact.ts";
import { byCodePoint } from "../core/compare.ts";

/** A grant the subject holds in the tenant, with the levels it may hand out. */
export type HeldGrant = {
  readonly grant: SnapshotGrant;
  readonly reach: readonly string[] | undefined;
};

/** An allow a custom role resolves to, with the levels it reaches. */
export type CustomAllow = {
  readonly key: string;
  readonly reach: readonly string[] | undefined;
};

/** A custom role of the tenant, resolved on the device. */
export type LocalCustomRole = {
  readonly name: string;
  readonly scope: string;
  readonly shared: boolean;
  readonly allows: readonly CustomAllow[];
};

/**
 * The levels a holder of `level` on `key` may hand out; `undefined` when the
 * table does not know the entry.
 */
export function entryReach(
  table: LocalCustomRoleTable,
  key: string,
  level: string | undefined,
): readonly string[] | undefined {
  const row = Object.hasOwn(table.permissions, key)
    ? table.permissions[key]
    : undefined;
  if (row === undefined) {
    return undefined;
  }
  if (level === undefined) {
    return row.reach;
  }
  return row.levelReach !== undefined && Object.hasOwn(row.levelReach, level)
    ? row.levelReach[level]
    : undefined;
}

/** The levels a holder of `role`'s included grants on `key` may hand out. */
export function includeReach(
  table: LocalCustomRoleTable,
  role: string,
  key: string,
): readonly string[] | undefined {
  const byKey =
    table.includeReach !== undefined && Object.hasOwn(table.includeReach, role)
      ? table.includeReach[role]
      : undefined;
  return byKey !== undefined && Object.hasOwn(byKey, key)
    ? byKey[key]
    : undefined;
}

function listOf(
  record: Readonly<Record<string, readonly string[]>> | undefined,
  key: string,
): readonly string[] {
  return record !== undefined && Object.hasOwn(record, key)
    ? (record[key] ?? [])
    : [];
}

/**
 * What the subject may hand out in `tenant`, by the rules of `assignableIn`:
 * declared assignable roles and the tenant's custom roles, intersected with the
 * permissions and levels the subject holds there. Holding a `meta.manageRoles`
 * role, or an unconditioned allow of a `meta.manageRoles` permission, lifts the
 * intersection.
 */
export function localAssignableFor(input: {
  readonly rules: LocalAssignable;
  readonly custom: Readonly<Record<string, LocalCustomRoleTable>>;
  readonly tenant: string;
  readonly heldNames: readonly string[];
  readonly held: readonly HeldGrant[];
  readonly customRoles: readonly LocalCustomRole[];
}): SnapshotAssignable {
  const { rules, custom, tenant, heldNames } = input;
  const allows = input.held.filter((item) => item.grant.effect === "allow");
  const heldKeys = new Set(allows.map((item) => item.grant.permission));
  const unconditioned = (effect: "allow" | "deny", key: string): boolean =>
    input.held.some(
      ({ grant }) =>
        grant.effect === effect &&
        grant.permission === key &&
        grant.where === undefined &&
        grant.check === undefined &&
        grant.approval === undefined &&
        grant.validity === undefined,
    );
  const manage =
    heldNames.some((name) => rules.manage.roles.includes(name)) ||
    rules.manage.permissions.some(
      (key) => unconditioned("allow", key) && !unconditioned("deny", key),
    );
  const held = new Set(heldNames);
  const listed =
    rules.assigns === undefined
      ? undefined
      : new Set(heldNames.flatMap((name) => listOf(rules.assigns, name)));
  const roles = rules.roles.filter((item) => {
    if (manage) {
      return true;
    }
    if (listed !== undefined) {
      return listed.has(item.name);
    }
    return (
      held.has(item.name) ||
      (item.allows.length > 0 && item.allows.every((key) => heldKeys.has(key)))
    );
  });
  const permissions = rules.permissions.filter(
    (leaf) => manage || heldKeys.has(leaf.key),
  );
  const offered = (key: string): readonly string[] => {
    const names = listOf(rules.levels, key);
    if (manage) {
      return names;
    }
    const reached = new Set(
      allows
        .filter((item) => item.grant.permission === key)
        .flatMap((item) => item.reach ?? []),
    );
    return names.filter((name) => reached.has(name));
  };
  const levels: Record<string, readonly string[]> = {};
  for (const leaf of permissions) {
    if (listOf(rules.levels, leaf.key).length > 0) {
      levels[leaf.key] = offered(leaf.key);
    }
  }
  const assignsAt = manage ? undefined : new Set(roles.map((item) => item.on));
  const mayHandOut = (scope: string, allow: CustomAllow): boolean => {
    const table = Object.hasOwn(custom, scope) ? custom[scope] : undefined;
    if (
      table === undefined ||
      !Object.hasOwn(table.permissions, allow.key) ||
      !(manage || heldKeys.has(allow.key))
    ) {
      return false;
    }
    if (listOf(rules.levels, allow.key).length === 0) {
      return true;
    }
    const can = offered(allow.key);
    return (allow.reach ?? []).every((name) => can.includes(name));
  };
  const customNames = input.customRoles
    .filter(
      (role) =>
        (assignsAt === undefined || assignsAt.has(role.scope)) &&
        role.allows.length > 0 &&
        role.allows.every((allow) => mayHandOut(role.scope, allow)),
    )
    .toSorted(
      (a, b) =>
        Number(!a.shared) - Number(!b.shared) || byCodePoint(a.name, b.name),
    )
    .map((role) => role.name);
  return compact<SnapshotAssignable>({
    tenant,
    roles: [...roles.map((item) => item.name), ...new Set(customNames)],
    permissions,
    levels: Object.keys(levels).length === 0 ? undefined : levels,
  });
}
