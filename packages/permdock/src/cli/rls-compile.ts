import type { GrantValidity } from "../core/policy.ts";
import type { Condition, Policy, ResourceNode } from "../index.ts";
import type { RlsGrant } from "./rls-grants.ts";
import type { RolePermission } from "./rls-helpers.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type { RlsActions } from "./types.ts";

import { canonicalJson } from "../core/canonical-json.ts";
import { sole } from "../core/compact.ts";
import { andWhere, leveled } from "../core/custom-roles.ts";
import { policyLevels } from "../core/policy.ts";
import { scopeField } from "../core/tenancy.ts";
import {
  formerKeys,
  hasConditionOp,
  listPermissions,
  requiresApproval,
} from "../index.ts";
import { jsonSchemaOf } from "./catalog-doc.ts";
import { apiKeyAllowsCall } from "./rls-api-keys.ts";
import {
  breakGlassHolder,
  breakGlassKey,
  collectGrants,
} from "./rls-grants.ts";
import { accessSql, capabilityAccessSql } from "./rls-helpers.ts";
import { indexedFields } from "./rls-indexes.ts";
import { requiresSql } from "./rls-permission-keys.ts";
import {
  arrayColumnsOf,
  columnTypesOf,
  compileConditionSql,
  contextRefs,
  quoteLiteral,
  sqlFunctionNames,
  subjectClaimJsonSql,
  subjectClaimSql,
} from "./rls-sql.ts";

export type SqlCommand = "select" | "insert" | "update" | "delete";

/**
 * One grant (or one grant-key group) on one table and command, before
 * policies are assembled. `access` is the helper call or membership join;
 * `using` and `check` hold only the portable row condition.
 */
export type CompiledBranch = {
  readonly table: string;
  readonly command: SqlCommand;
  readonly effect: "allow" | "deny";
  /** Postgres roles the policy targets: `authenticated`, plus `anon` for `anyone()`. */
  readonly roles: readonly string[];
  /** Role name, `anyone` or `authenticated`. */
  readonly label: string;
  readonly resource?: string;
  readonly permissionKey: string;
  readonly grantKey?: string;
  /** The grant's `fields`; absent means every field. */
  readonly fields?: readonly string[];
  readonly access?: string;
  readonly using?: string;
  readonly check?: string;
  /** Added only so `update` / `delete` can see their rows. */
  readonly coverage?: true;
};

export type CompiledPolicy = {
  readonly name: string;
  readonly table: string;
  readonly command: SqlCommand;
  readonly effect: "allow" | "deny";
  readonly roles: readonly string[];
  readonly using?: string;
  readonly check?: string;
};

export type CompiledGrants = {
  readonly branches: readonly CompiledBranch[];
  /** With `rowActions`: branches of actions with no SQL command, compiled as reads for `permitted_<resource>_rows` only. */
  readonly actionBranches: readonly CompiledBranch[];
  readonly rolePermissions: readonly RolePermission[];
  /** The row columns policies filter on: scope keys and condition fields. */
  readonly rowColumns: readonly {
    readonly resource: string;
    readonly table: string;
    readonly column: string;
  }[];
  /** Grant keys whose grants carry a row condition or a validity window, which a key-only check cannot apply. */
  readonly conditionedKeys: ReadonlySet<string>;
  /**
   * `[grant key, level]` for every allow on a resource with levels: the
   * levels a holder of the key may hand out in a custom role, as
   * `assignableLevels` counts them in-process.
   */
  readonly levelReach: readonly (readonly [string, string])[];
};

/**
 * The levels an allow reaches: every level without a row condition, else the
 * levels whose condition equals its condition.
 */
function reachedLevels(
  where: Condition | undefined,
  levels: readonly (readonly [string, Condition])[],
): readonly string[] {
  if (where === undefined) {
    return levels.map(([name]) => name);
  }
  const held = canonicalJson(where);
  return levels
    .filter(([, condition]) => canonicalJson(condition) === held)
    .map(([name]) => name);
}

function levelReachOf(
  policy: Policy,
  keys: ReadonlyMap<Prepared, string>,
): readonly (readonly [string, string])[] {
  const reach = new Map<string, Set<string>>();
  for (const [entry, grantKey] of keys) {
    const { item } = entry;
    const { grant } = item;
    if (
      item.access.kind !== "role" ||
      grant.effect !== "allow" ||
      grant.permission.kind !== "instance" ||
      grant.level !== undefined
    ) {
      continue;
    }
    const levels = policyLevels(policy, grant.permission.resource);
    if (levels.length > 0) {
      const set = reach.get(grantKey) ?? new Set<string>();
      for (const name of reachedLevels(grant.where, levels)) {
        set.add(name);
      }
      reach.set(grantKey, set);
    }
  }
  const out: (readonly [string, string])[] = [];
  for (const grantKey of new Set(keys.values())) {
    const at = grantKey.lastIndexOf("@");
    const base = at === -1 ? grantKey : grantKey.slice(0, at);
    const level = at === -1 ? undefined : grantKey.slice(at + 1);
    for (const name of reach.get(base) ?? []) {
      if (level === undefined || level === name) {
        out.push([grantKey, name]);
      }
    }
  }
  return out.toSorted(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1,
  );
}

/** The SQL command `action` compiles to: `rls.actions` first, then the six default verbs. */
export function commandFor(
  action: string,
  actions?: RlsActions,
): SqlCommand | undefined {
  if (actions !== undefined && Object.hasOwn(actions, action)) {
    const configured = actions[action];
    return configured === "none" ? undefined : configured;
  }
  switch (action) {
    case "read":
    case "list":
    case "get":
      return "select";
    case "create":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    default:
      return undefined;
  }
}

export function tableFor(
  resource: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  return tables?.[resource] ?? resource;
}

function ancestorsOf(policy: Policy, name: string): readonly string[] {
  const names: string[] = [];
  let current = policy.resources.get(name);
  while (
    current?.parent !== undefined &&
    !names.includes(current.parent.resource)
  ) {
    names.push(current.parent.resource);
    current = policy.resources.get(current.parent.resource);
  }
  return names;
}

function membershipField(
  policy: Policy,
  resource: ResourceNode | undefined,
  holder: string,
): string | undefined {
  if (resource === undefined) {
    return undefined;
  }
  if (resource.name === holder) {
    return resource.id ?? "id";
  }
  let current: ResourceNode | undefined = resource;
  const seen = new Set<string>();
  while (current?.parent !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    if (current.parent.resource === holder) {
      return current.parent.field;
    }
    current = policy.resources.get(current.parent.resource);
  }
  return undefined;
}

// Mirrors `matchResourceMembership`: a membership on the role's resource or
// one of its ancestors, keyed by the row field that holds that resource's id.
function resourceCondition(
  item: RlsGrant,
  policy: Policy,
  ctx: RlsSqlContext,
): Condition {
  if (item.access.kind !== "resource") {
    throw new Error("PermDock CLI: resourceCondition needs a resource role");
  }
  const { role, resource: roleResource } = item.access;
  const target = policy.resources.get(item.grant.permission.resource);
  const holders = [roleResource, ...ancestorsOf(policy, roleResource)];
  const hops: Condition[] = [];
  for (const [index, holder] of holders.entries()) {
    const field = membershipField(policy, target, holder);
    if (field === undefined) {
      continue;
    }
    if (index > 0 && ctx.memberships?.resource?.[holder] === undefined) {
      continue;
    }
    hops.push({
      op: "memberOf",
      scope: "resource",
      field,
      roles: [role],
      resource: holder,
    });
  }
  return sole(hops) ?? { op: "or", conditions: hops };
}

/**
 * The access a link capability has to a resource-scoped grant, over the same
 * holders as `resourceCondition`. It reads the claim, so ancestor hops need
 * no memberships table. `undefined` when no holder is on the row's chain.
 */
function capabilityAccess(
  item: RlsGrant,
  policy: Policy,
  ctx: RlsSqlContext,
): string | undefined {
  if (item.access.kind !== "resource") {
    return undefined;
  }
  const { role, resource: roleResource } = item.access;
  // A capability's membership has kind `link`, so a role whose `for` omits it holds nothing through a link.
  const kinds = ctx.ownership?.kinds[role];
  if (kinds !== undefined && !kinds.includes("link")) {
    return undefined;
  }
  const target = policy.resources.get(item.grant.permission.resource);
  const hops: string[] = [];
  for (const holder of [roleResource, ...ancestorsOf(policy, roleResource)]) {
    const field = membershipField(policy, target, holder);
    if (field !== undefined) {
      hops.push(
        capabilityAccessSql(
          ctx,
          field,
          holder,
          role,
          item.grant.permission.key,
        ),
      );
    }
  }
  if (hops.length === 0) {
    return undefined;
  }
  return hops.length === 1 ? hops[0] : hops.map(wrapSql).join(" or ");
}

type Prepared = {
  readonly item: RlsGrant;
  /** `'none'`: the action has no SQL command, so the grant is only seeded for `permdock_has`. */
  readonly command: SqlCommand | "none";
  readonly table: string;
  /** Row condition on the current row (`USING`). */
  readonly using?: Condition;
  /** Row condition on the proposed row (`WITH CHECK`). */
  readonly check?: Condition;
};

function prepare(
  item: RlsGrant,
  tables: Readonly<Record<string, string>> | undefined,
  warnings: string[],
  skipClosures: boolean,
  actions: RlsActions | undefined,
  rowActions = false,
): Prepared | undefined {
  const { grant, label } = item;
  if (grant.breakGlass !== undefined) {
    // Break-glass never becomes a policy: the generated security definer
    // function reads restricted rows instead, so plain RLS keeps denying them.
    warnings.push(
      `break-glass grant ${label}/${grant.permission.key} reads through permdock_break_glass_${grant.permission.resource}, not a policy`,
    );
    return undefined;
  }
  if (grant.closure !== undefined || grant.portable === false) {
    if (skipClosures) {
      warnings.push(
        `skipped non-portable grant ${label}/${grant.permission.key}`,
      );
      return undefined;
    }
    throw new Error(
      `PermDock CLI: closure grant ${label}/${grant.permission.key} is not portable; rewrite it or pass --skip-closures`,
    );
  }
  const context = [
    ...new Set([...contextRefs(item.where), ...contextRefs(grant.check)]),
  ];
  if (context.length > 0) {
    if (skipClosures) {
      warnings.push(
        `skipped grant ${label}/${grant.permission.key}: it reads ${context.join(", ")}, which is not in the token`,
      );
      return undefined;
    }
    throw new Error(
      `PermDock CLI: grant ${label}/${grant.permission.key} reads ${context.join(", ")}; request context is not in the token, so RLS cannot compile it. Move the value to a server-set claim (principal.claims.*) or pass --skip-closures (permdock doctor PD027)`,
    );
  }
  if (requiresApproval(grant.approval)) {
    warnings.push(`skipped approval grant ${label}/${grant.permission.key}`);
    return undefined;
  }
  const command = commandFor(grant.permission.action, actions);
  const table = tableFor(grant.permission.resource, tables);
  if (command === undefined) {
    if (item.access.kind !== "role" && rowActions) {
      warnings.push(
        `no policy for ${label}/${grant.permission.key}: action '${grant.permission.action}' has no SQL command (rls.actions); only permitted_<resource>_rows answers it`,
      );
      return {
        item,
        command: "none",
        table,
        ...(item.where === undefined ? {} : { using: item.where }),
      };
    }
    if (item.access.kind !== "role") {
      warnings.push(
        `skipped ${label}/${grant.permission.key}: action '${grant.permission.action}' has no SQL command (rls.actions) and only role grants are seeded`,
      );
      return undefined;
    }
    if (grant.validity !== undefined && grant.effect === "allow") {
      warnings.push(
        `skipped ${label}/${grant.permission.key}: a role_permissions row cannot carry validFrom / validUntil, so a time-bounded grant on an action with no SQL command is not seeded`,
      );
      return undefined;
    }
    warnings.push(
      `no policy for ${label}/${grant.permission.key}: action '${grant.permission.action}' has no SQL command (rls.actions); seeded for permdock_has and permitted_<scope>_ids`,
    );
    return {
      item,
      command: "none",
      table,
      ...(item.where === undefined ? {} : { using: item.where }),
      ...(grant.check === undefined ? {} : { check: grant.check }),
    };
  }
  const using = command === "insert" ? undefined : item.where;
  const check =
    command === "insert"
      ? (grant.check ?? item.where)
      : command === "update"
        ? (grant.check ?? item.where)
        : undefined;
  return {
    item,
    command,
    table,
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  };
}

function signature(entry: Prepared, byFields: boolean): string {
  const base = [
    entry.item.grant.effect,
    entry.using ?? null,
    entry.check ?? null,
  ];
  return JSON.stringify(
    byFields ? [...base, entry.item.grant.fields ?? null] : base,
  );
}

/**
 * Grant keys per permission: the key is the permission, split into
 * `permission#n` when role grants carry different portable conditions (or
 * effects), one key per condition group; a group whose grants set `group`
 * is `permission#<group>` instead. With field views, grants that differ
 * only in `fields` get their own keys too, so a view can tell them apart.
 */
function assignKeys(
  entries: readonly Prepared[],
  byFields: boolean,
): Map<Prepared, string> {
  const groups = new Map<string, Map<string, Prepared[]>>();
  for (const entry of entries) {
    if (entry.item.access.kind !== "role") {
      continue;
    }
    const key = entry.item.grant.permission.key;
    const byCondition = groups.get(key) ?? new Map<string, Prepared[]>();
    const sig = signature(entry, byFields);
    byCondition.set(sig, [...(byCondition.get(sig) ?? []), entry]);
    groups.set(key, byCondition);
  }
  const keys = new Map<Prepared, string>();
  for (const [permission, byCondition] of groups) {
    const lists = [...byCondition.values()];
    const named = new Set<string>();
    for (const [index, list] of lists.entries()) {
      const group = groupOf(permission, list);
      if (group !== undefined && named.has(group)) {
        throw new Error(
          `PermDock CLI: grants of ${permission} with different conditions share group '${group}'; a group names one condition`,
        );
      }
      if (group !== undefined) {
        named.add(group);
      }
      const grantKey =
        group !== undefined
          ? `${permission}#${group}`
          : lists.length === 1
            ? permission
            : `${permission}#${index + 1}`;
      for (const entry of list) {
        keys.set(entry, grantKey);
      }
    }
  }
  return keys;
}

function groupOf(
  permission: string,
  list: readonly Prepared[],
): string | undefined {
  const names = [
    ...new Set(
      list.flatMap((entry) =>
        entry.item.grant.group === undefined ? [] : [entry.item.grant.group],
      ),
    ),
  ].toSorted();
  if (names.length > 1) {
    throw new Error(
      `PermDock CLI: grants of ${permission} with one condition name the groups ${names.join(", ")}; give them one group`,
    );
  }
  return names[0];
}

/**
 * One entry per level for every allow of an assignable role on a resource
 * with levels, keyed `<grant key>@<level>`. Only `permdock_custom_keys`
 * hands these keys out, to a custom role whose stored allow names the level.
 */
function levelEntries(
  policy: Policy,
  ctx: RlsSqlContext,
  keys: Map<Prepared, string>,
  tables: Readonly<Record<string, string>> | undefined,
  warnings: string[],
  skipClosures: boolean,
): Prepared[] {
  const custom = ctx.customRoles;
  if (custom?.levels !== true) {
    return [];
  }
  const assignable = new Set(custom.assignable);
  const out: Prepared[] = [];
  // The loop adds the leveled keys to `keys`, so it walks a copy.
  for (const [entry, grantKey] of Array.from(keys)) {
    const { item } = entry;
    const { grant } = item;
    if (
      item.access.kind !== "role" ||
      grant.effect !== "allow" ||
      grant.permission.kind !== "instance" ||
      !assignable.has(item.access.role)
    ) {
      continue;
    }
    if (grant.permission.key.includes("@")) {
      throw new Error(
        `PermDock CLI: permission key '${grant.permission.key}' holds '@', which separates a level in custom-role grant keys`,
      );
    }
    for (const [level, condition] of policyLevels(
      policy,
      grant.permission.resource,
    )) {
      const where = andWhere(item.where, condition);
      const narrowed: RlsGrant = {
        ...item,
        grant: leveled(grant, level, condition),
        ...(where === undefined ? {} : { where }),
      };
      const prepared = prepare(
        narrowed,
        tables,
        warnings,
        skipClosures,
        ctx.actions,
      );
      if (prepared !== undefined) {
        keys.set(prepared, `${grantKey}@${level}`);
        out.push(prepared);
      }
    }
  }
  return out;
}

function compileOptional(
  condition: Condition | undefined,
  ctx: RlsSqlContext,
): string | undefined {
  return condition === undefined
    ? undefined
    : compileConditionSql(condition, ctx);
}

function noteConditions(entry: Prepared, warnings: string[]): void {
  const { label, grant } = entry.item;
  const names = [
    ...sqlFunctionNames(entry.using),
    ...sqlFunctionNames(entry.check),
  ];
  if (names.length > 0) {
    warnings.push(
      `sqlFunction ${[...new Set(names)].join(", ")} on ${label}/${grant.permission.key} is portable via twin`,
    );
  }
  if (
    hasConditionOp(entry.using, "opaque") ||
    hasConditionOp(entry.check, "opaque")
  ) {
    warnings.push(
      `opaque SQL on ${label}/${grant.permission.key} is untestable app-side`,
    );
  }
}

/**
 * Compiles every grant (role and top-level) to branches whose role check is
 * a helper call keyed by grant key. Nothing in a branch is per-row except the
 * portable row condition and resource-membership joins.
 */
/** A Supabase token from a permanent user: anonymous sign-ins carry `is_anonymous: true`. */
const PERMANENT_USER = `((select auth.jwt()) ->> 'is_anonymous') is distinct from 'true'`;

export function compileGrants(
  policy: Policy,
  ctx: RlsSqlContext,
  tables: Readonly<Record<string, string>> | undefined,
  warnings: string[],
  skipClosures: boolean,
  rowActions = false,
): CompiledGrants {
  const items = collectGrants(policy);
  const entries = items.flatMap((item) => {
    const entry = prepare(
      item,
      tables,
      warnings,
      skipClosures,
      ctx.actions,
      rowActions,
    );
    return entry === undefined ? [] : [entry];
  });
  const keys = assignKeys(entries, ctx.fields === "views");
  entries.push(
    ...levelEntries(policy, ctx, keys, tables, warnings, skipClosures),
  );
  const conditionedKeys = new Set<string>();
  for (const [entry, grantKey] of keys) {
    if (
      entry.using !== undefined ||
      entry.check !== undefined ||
      entry.item.grant.validity !== undefined ||
      entry.item.grant.requires !== undefined
    ) {
      conditionedKeys.add(grantKey);
    }
  }
  const rows = new Map<string, RolePermission>();
  for (const item of items) {
    const holder =
      item.grant.breakGlass === undefined ? undefined : breakGlassHolder(item);
    if (holder !== undefined) {
      const row: RolePermission = {
        role: holder.role,
        permission: item.grant.permission.key,
        grantKey: breakGlassKey(item.grant.permission.key),
        scope: holder.scope,
        effect: item.grant.effect,
      };
      rows.set(`${row.role}\u0000${row.grantKey}\u0000${row.scope}`, row);
    }
  }
  const branches: CompiledBranch[] = [];
  const actionBranches: CompiledBranch[] = [];
  const rowColumns = new Map<
    string,
    { resource: string; table: string; column: string }
  >();
  const filters = (resource: string, table: string, column: string): void => {
    rowColumns.set(`${table}\u0000${column}`, { resource, table, column });
  };
  const typed = new Map<string, RlsSqlContext>();
  const contextFor = (name: string): RlsSqlContext => {
    const known = typed.get(name);
    if (known !== undefined) {
      return known;
    }
    const node = policy.resources.get(name);
    const schema = node === undefined ? undefined : jsonSchemaOf(node);
    const next = {
      ...ctx,
      columnTypes: columnTypesOf(schema),
      arrayColumns: arrayColumnsOf(schema),
    };
    typed.set(name, next);
    return next;
  };
  for (const entry of entries) {
    const { item, table } = entry;
    const { grant, access, label } = item;
    if (entry.command === "none") {
      const grantKey = keys.get(entry);
      if (access.kind === "role" && grantKey !== undefined) {
        const row: RolePermission = {
          role: access.role,
          permission: grant.permission.key,
          grantKey,
          scope: access.scope,
          effect: grant.effect,
        };
        rows.set(`${row.role}\u0000${row.grantKey}\u0000${row.scope}`, row);
      }
      if (!rowActions) {
        continue;
      }
    }
    const actionOnly = entry.command === "none";
    const command = actionOnly ? "select" : entry.command;
    const target = actionOnly ? actionBranches : branches;
    const rowCtx = {
      ...contextFor(item.grant.permission.resource),
      permission: grant.permission.key,
    };
    noteConditions(entry, warnings);
    for (const field of [
      ...indexedFields(entry.using),
      ...indexedFields(entry.check),
    ]) {
      filters(grant.permission.resource, table, field);
    }
    const grantKey = keys.get(entry);
    let accessExpr: string | undefined;
    if (access.kind === "role" && grantKey !== undefined) {
      const column =
        access.scope === "global"
          ? undefined
          : scopeField(
              policy.resources.get(grant.permission.resource),
              access.scope,
              policy.scopes,
            );
      accessExpr = accessSql(ctx, access.scope, grantKey, column);
      if (column !== undefined) {
        filters(grant.permission.resource, table, column);
      }
      const row: RolePermission = {
        role: access.role,
        permission: grant.permission.key,
        grantKey,
        scope: access.scope,
        effect: grant.effect,
      };
      rows.set(`${row.role}\u0000${row.grantKey}\u0000${row.scope}`, row);
    }
    const linkOnly =
      access.kind === "resource" &&
      ctx.capabilities === true &&
      ctx.memberships?.resource?.[access.resource] === undefined;
    if (access.kind === "actor") {
      accessExpr = `${subjectClaimSql(ctx, "client_id")} is not null or ${subjectClaimJsonSql(ctx, "act")} is not null`;
    }
    if (access.kind === "resource" && !linkOnly) {
      accessExpr = compileConditionSql(resourceCondition(item, policy, ctx), {
        ...ctx,
        permission: grant.permission.key,
      });
    }
    if (linkOnly) {
      warnings.push(
        `no ${access.resource} memberships table: only link capabilities reach ${label}/${grant.permission.key}`,
      );
    }
    const validity = validitySql(grant.validity);
    accessExpr = andSql(accessExpr, validity);
    for (const key of grant.requires ?? []) {
      accessExpr = andSql(
        accessExpr,
        requiresSql(ctx, key, policy.resources.get(grant.permission.resource)),
      );
    }
    if (ctx.anonymousSignIns === "deny" && access.kind !== "anyone") {
      accessExpr = andSql(accessExpr, PERMANENT_USER);
    }
    if (
      ctx.apiKeys !== undefined &&
      grant.effect === "allow" &&
      access.kind !== "anyone" &&
      access.kind !== "role"
    ) {
      const calls = [grant.permission.key, ...(grant.requires ?? [])].map(
        (key) => `(select ${apiKeyAllowsCall(ctx, quoteLiteral(key))})`,
      );
      accessExpr = andSql(
        accessExpr,
        calls.length === 1 ? (calls[0] ?? "") : `(${calls.join(" or ")})`,
      );
    }
    const using = compileOptional(entry.using, rowCtx);
    const check = compileOptional(entry.check, rowCtx);
    const fields = grant.fields === undefined ? {} : { fields: grant.fields };
    if (!linkOnly) {
      target.push({
        table,
        command,
        effect: grant.effect,
        roles:
          access.kind === "anyone"
            ? ["anon", "authenticated"]
            : ["authenticated"],
        label,
        resource: grant.permission.resource,
        permissionKey: grant.permission.key,
        ...fields,
        ...(grantKey === undefined ? {} : { grantKey }),
        ...(accessExpr === undefined ? {} : { access: accessExpr }),
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    }
    const linked =
      ctx.capabilities === true
        ? capabilityAccess(item, policy, ctx)
        : undefined;
    if (linked !== undefined) {
      target.push({
        table,
        command,
        effect: grant.effect,
        roles: ["anon"],
        label,
        resource: grant.permission.resource,
        permissionKey: grant.permission.key,
        ...fields,
        access: andSql(linked, validity) ?? linked,
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    }
  }
  return {
    branches: ensureSelectCoverage(branches, warnings),
    actionBranches,
    rolePermissions: withAliasRows(policy, [...rows.values()]),
    conditionedKeys,
    rowColumns: [...rowColumns.values()],
    levelReach:
      ctx.customRoles?.levels === true ? levelReachOf(policy, keys) : [],
  };
}

/**
 * Each row again under every key its permission was renamed from, so SQL that
 * still calls `permdock_has('<old key>')` keeps the access the current key
 * has. A split grant key (`key#n`) keeps its suffix; break-glass rows are not
 * copied.
 */
function withAliasRows(
  policy: Policy,
  rows: readonly RolePermission[],
): RolePermission[] {
  const former = new Map(
    listPermissions(policy.permissions).map((leaf) => [
      leaf.key,
      formerKeys(leaf),
    ]),
  );
  const out = [...rows];
  for (const row of rows) {
    const suffix = row.grantKey.slice(row.permission.length);
    if (
      !row.grantKey.startsWith(row.permission) ||
      (suffix !== "" &&
        (!/^#[a-z0-9][a-z0-9_-]*$/u.test(suffix) || suffix === "#break-glass"))
    ) {
      continue;
    }
    for (const old of former.get(row.permission) ?? []) {
      out.push({ ...row, permission: old, grantKey: `${old}${suffix}` });
    }
  }
  return out;
}

/**
 * Postgres needs SELECT access to find rows for UPDATE / DELETE and for
 * RETURNING, so a table with only update or delete grants gets matching
 * SELECT branches.
 */
function ensureSelectCoverage(
  branches: readonly CompiledBranch[],
  warnings: string[],
): CompiledBranch[] {
  const extra: CompiledBranch[] = [];
  const readable = new Set(
    branches
      .filter((item) => item.command === "select" && item.effect === "allow")
      .map((item) => item.table),
  );
  const covered = new Set<string>();
  for (const item of branches) {
    if (
      item.effect !== "allow" ||
      (item.command !== "update" && item.command !== "delete") ||
      readable.has(item.table)
    ) {
      continue;
    }
    const { check: _check, ...rest } = item;
    extra.push({ ...rest, command: "select", coverage: true });
    if (!covered.has(item.table)) {
      covered.add(item.table);
      warnings.push(
        `added SELECT coverage for ${item.table} (${item.permissionKey})`,
      );
    }
  }
  return [...branches, ...extra];
}

/** True when `sql` is one parenthesised expression, so AND / OR need not wrap it again. */
function isWrapped(sql: string): boolean {
  if (!sql.startsWith("(") || !sql.endsWith(")")) {
    return false;
  }
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index];
    if (ch === "'") {
      quoted = !quoted;
    } else if (!quoted && ch === "(") {
      depth += 1;
    } else if (!quoted && ch === ")") {
      depth -= 1;
      if (depth === 0 && index < sql.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function wrapSql(sql: string): string {
  return isWrapped(sql) ? sql : `(${sql})`;
}

/**
 * The grant's `validFrom` / `validUntil` as a clock check: `from` inclusive,
 * `until` exclusive, matching the in-process evaluator.
 */
function validitySql(validity: GrantValidity | undefined): string | undefined {
  if (validity === undefined) {
    return undefined;
  }
  return andSql(
    validity.from === undefined
      ? undefined
      : `now() >= to_timestamp(${validity.from})`,
    validity.until === undefined
      ? undefined
      : `now() < to_timestamp(${validity.until})`,
  );
}

export function andSql(
  ...parts: readonly (string | undefined)[]
): string | undefined {
  const present = parts.filter(
    (part): part is string => part !== undefined && part !== "true",
  );
  if (present.length === 0) {
    return undefined;
  }
  return present.length === 1 ? present[0] : present.map(wrapSql).join(" and ");
}

/** `USING` and `WITH CHECK` for a branch: its access check ANDed with its row conditions. */
export function branchClauses(branch: CompiledBranch): {
  readonly using?: string;
  readonly check?: string;
} {
  const using =
    branch.command === "insert"
      ? undefined
      : (andSql(branch.access, branch.using) ?? "true");
  const check =
    branch.command === "insert" || branch.command === "update"
      ? (andSql(branch.access, branch.check) ?? "true")
      : undefined;
  return {
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  };
}
