import type { Condition, Policy, ResourceNode } from '../index.ts';
import type { RlsGrant } from './rls-grants.ts';
import type { RolePermission } from './rls-helpers.ts';
import type { RlsSqlContext } from './rls-sql.ts';

import { hasConditionOp, requiresApproval } from '../index.ts';
import { collectGrants } from './rls-grants.ts';
import { accessSql, capabilityAccessSql } from './rls-helpers.ts';
import { compileConditionSql, sqlFunctionNames } from './rls-sql.ts';

export type SqlCommand = 'select' | 'insert' | 'update' | 'delete';

/**
 * One grant (or one grant-key group) on one table and command, before
 * policies are assembled. `access` is the helper call or membership join;
 * `using` and `check` hold only the portable row condition.
 */
export type CompiledBranch = {
  readonly table: string;
  readonly command: SqlCommand;
  readonly effect: 'allow' | 'deny';
  /** Postgres roles the policy targets: `authenticated`, plus `anon` for `anyone()`. */
  readonly roles: readonly string[];
  /** Role name, `anyone` or `authenticated`. */
  readonly label: string;
  readonly permissionKey: string;
  readonly grantKey?: string;
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
  readonly effect: 'allow' | 'deny';
  readonly roles: readonly string[];
  readonly using?: string;
  readonly check?: string;
};

export type CompiledGrants = {
  readonly branches: readonly CompiledBranch[];
  readonly rolePermissions: readonly RolePermission[];
  /** Tables and columns that row conditions filter on, for index suggestions. */
  readonly filtered: readonly string[];
};

export function commandFor(action: string): SqlCommand | undefined {
  switch (action) {
    case 'read':
    case 'list':
    case 'get':
      return 'select';
    case 'create':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
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
    return resource.id ?? 'id';
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
export function resourceCondition(
  item: RlsGrant,
  policy: Policy,
  ctx: RlsSqlContext,
): Condition {
  if (item.access.kind !== 'resource') {
    throw new Error('PermDock CLI: resourceCondition needs a resource role');
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
      op: 'memberOf',
      scope: 'resource',
      field,
      roles: [role],
      resource: holder,
    });
  }
  return hops.length === 1 ? hops[0]! : { op: 'or', conditions: hops };
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
  if (item.access.kind !== 'resource') {
    return undefined;
  }
  const { role, resource: roleResource } = item.access;
  // A capability's membership has kind `link`, so a role whose `for` omits it holds nothing through a link.
  const kinds = ctx.ownership?.kinds[role];
  if (kinds !== undefined && !kinds.includes('link')) {
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
  return hops.length === 1 ? hops[0] : hops.map(wrapSql).join(' or ');
}

type Prepared = {
  readonly item: RlsGrant;
  readonly command: SqlCommand;
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
): Prepared | undefined {
  const { grant, label } = item;
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
  if (requiresApproval(grant.approval)) {
    warnings.push(`skipped approval grant ${label}/${grant.permission.key}`);
    return undefined;
  }
  const command = commandFor(grant.permission.action);
  if (command === undefined) {
    warnings.push(
      `skipped ${grant.permission.key}: action is not a SQL command`,
    );
    return undefined;
  }
  const table = tableFor(grant.permission.resource, tables);
  const using = command === 'insert' ? undefined : item.where;
  const check =
    command === 'insert'
      ? (grant.check ?? item.where)
      : command === 'update'
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

function signature(entry: Prepared): string {
  return JSON.stringify([
    entry.item.grant.effect,
    entry.using ?? null,
    entry.check ?? null,
  ]);
}

/**
 * Grant keys per permission: the key is the permission, split into
 * `permission#n` when role grants carry different portable conditions (or
 * effects), one key per condition group.
 */
function assignKeys(entries: readonly Prepared[]): Map<Prepared, string> {
  const groups = new Map<string, Map<string, Prepared[]>>();
  for (const entry of entries) {
    if (entry.item.access.kind !== 'role') {
      continue;
    }
    const key = entry.item.grant.permission.key;
    const byCondition = groups.get(key) ?? new Map<string, Prepared[]>();
    const sig = signature(entry);
    byCondition.set(sig, [...(byCondition.get(sig) ?? []), entry]);
    groups.set(key, byCondition);
  }
  const keys = new Map<Prepared, string>();
  for (const [permission, byCondition] of groups) {
    const lists = [...byCondition.values()];
    for (const [index, list] of lists.entries()) {
      const grantKey =
        lists.length === 1 ? permission : `${permission}#${index + 1}`;
      for (const entry of list) {
        keys.set(entry, grantKey);
      }
    }
  }
  return keys;
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
      `sqlFunction ${[...new Set(names)].join(', ')} on ${label}/${grant.permission.key} is portable via twin`,
    );
  }
  if (
    hasConditionOp(entry.using, 'opaque') ||
    hasConditionOp(entry.check, 'opaque')
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
export function compileGrants(
  policy: Policy,
  ctx: RlsSqlContext,
  tables: Readonly<Record<string, string>> | undefined,
  warnings: string[],
  skipClosures: boolean,
): CompiledGrants {
  const entries = collectGrants(policy).flatMap((item) => {
    const entry = prepare(item, tables, warnings, skipClosures);
    return entry === undefined ? [] : [entry];
  });
  const keys = assignKeys(entries);
  const rows = new Map<string, RolePermission>();
  const branches: CompiledBranch[] = [];
  const filtered = new Set<string>();
  for (const entry of entries) {
    const { item, command, table } = entry;
    const { grant, access, label } = item;
    noteConditions(entry, warnings);
    for (const condition of [entry.using, entry.check]) {
      if (condition !== undefined && 'field' in condition) {
        filtered.add(`${table}.${condition.field}`);
      }
    }
    const grantKey = keys.get(entry);
    let accessExpr: string | undefined;
    if (access.kind === 'role' && grantKey !== undefined) {
      const column =
        access.scope === 'global'
          ? undefined
          : policy.scopes.find((scope) => scope.name === access.scope)?.key;
      accessExpr = accessSql(ctx, access.scope, grantKey, column);
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
      access.kind === 'resource' &&
      ctx.capabilities === true &&
      ctx.memberships?.resource?.[access.resource] === undefined;
    if (access.kind === 'resource' && !linkOnly) {
      accessExpr = compileConditionSql(
        resourceCondition(item, policy, ctx),
        ctx,
      );
    }
    if (linkOnly) {
      warnings.push(
        `no ${access.resource} memberships table: only link capabilities reach ${label}/${grant.permission.key}`,
      );
    }
    const using = compileOptional(entry.using, ctx);
    const check = compileOptional(entry.check, ctx);
    if (!linkOnly) {
      branches.push({
        table,
        command,
        effect: grant.effect,
        roles:
          access.kind === 'anyone'
            ? ['anon', 'authenticated']
            : ['authenticated'],
        label,
        permissionKey: grant.permission.key,
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
      branches.push({
        table,
        command,
        effect: grant.effect,
        roles: ['anon'],
        label,
        permissionKey: grant.permission.key,
        access: linked,
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    }
  }
  return {
    branches: ensureSelectCoverage(branches, warnings),
    rolePermissions: [...rows.values()],
    filtered: [...filtered],
  };
}

/**
 * Postgres needs SELECT access to find rows for UPDATE / DELETE and for
 * RETURNING, so a table with only update or delete grants gets matching
 * SELECT branches.
 */
export function ensureSelectCoverage(
  branches: readonly CompiledBranch[],
  warnings: string[],
): CompiledBranch[] {
  const extra: CompiledBranch[] = [];
  const readable = new Set(
    branches
      .filter((item) => item.command === 'select' && item.effect === 'allow')
      .map((item) => item.table),
  );
  const covered = new Set<string>();
  for (const item of branches) {
    if (
      item.effect !== 'allow' ||
      (item.command !== 'update' && item.command !== 'delete') ||
      readable.has(item.table)
    ) {
      continue;
    }
    const { check: _check, ...rest } = item;
    extra.push({ ...rest, command: 'select', coverage: true });
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
  if (!sql.startsWith('(') || !sql.endsWith(')')) {
    return false;
  }
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const ch = sql[index];
    if (ch === "'") {
      quoted = !quoted;
    } else if (!quoted && ch === '(') {
      depth += 1;
    } else if (!quoted && ch === ')') {
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

export function andSql(
  ...parts: readonly (string | undefined)[]
): string | undefined {
  const present = parts.filter(
    (part): part is string => part !== undefined && part !== 'true',
  );
  if (present.length === 0) {
    return undefined;
  }
  return present.length === 1 ? present[0] : present.map(wrapSql).join(' and ');
}

/** `USING` and `WITH CHECK` for a branch: its access check ANDed with its row conditions. */
export function branchClauses(branch: CompiledBranch): {
  readonly using?: string;
  readonly check?: string;
} {
  const using =
    branch.command === 'insert'
      ? undefined
      : (andSql(branch.access, branch.using) ?? 'true');
  const check =
    branch.command === 'insert' || branch.command === 'update'
      ? (andSql(branch.access, branch.check) ?? 'true')
      : undefined;
  return {
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
  };
}
