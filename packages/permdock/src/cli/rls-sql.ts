import type { Condition, ConditionValue } from '../index.ts';
import type {
  RlsDialect,
  RlsMembershipTable,
  RlsMemberships,
} from './types.ts';

import { isSqlFunctionField } from '../index.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLAIM = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RlsSqlContext = {
  readonly dialect: RlsDialect;
  readonly memberships?: RlsMemberships;
  readonly tenantClaim: string;
  readonly gucPrefix: string;
  readonly inlineFunctions?: boolean;
  /** Schema of `role_permissions` and the RLS helpers (`permdock_has`, `permitted_<scope>_ids`). Default `public`. */
  readonly schema?: string;
  /** Where the helpers read roles and memberships: tables (`database`) or claims (`jwt`, the default). */
  readonly authorize?: 'database' | 'jwt';
  /** Claim holding the global role (string or array). Default `user_role`. */
  readonly roleClaim?: string;
  /** Postgres type of the tenant column; the tenant claim is cast to it. Default `uuid`. */
  readonly tenantType?: string;
  /** Postgres type of the team column. Defaults to `tenantType`. */
  readonly teamType?: string;
  /**
   * Set when custom roles compile: the helpers also resolve tenant-defined
   * roles, bounded by the ceiling of `assignable` declared roles.
   */
  readonly customRoles?: {
    readonly declared: readonly string[];
    readonly assignable: readonly string[];
  };
};

const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/u;

export function sqlType(name: string): string {
  if (!SQL_TYPE.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL type '${name}'`);
  }
  return name;
}

export function tenantTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.tenantType ?? 'uuid');
}

export function teamTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.teamType ?? ctx.tenantType ?? 'uuid');
}

/** The active-tenant claim cast to the tenant column's type, so the comparison uses the column's index. */
export function tenantClaimSql(ctx: RlsSqlContext): string {
  return `${subjectClaimSql(ctx, ctx.tenantClaim)}::${tenantTypeOf(ctx)}`;
}

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

export function quoteTable(name: string): string {
  return name.split('.').map(quoteIdent).join('.');
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function subjectIdSql(ctx: RlsSqlContext): string {
  switch (ctx.dialect) {
    case 'supabase':
      return '(select auth.uid())';
    case 'neon':
      return '(select auth.user_id())';
    case 'guc':
      return `current_setting(${quoteLiteral(`${ctx.gucPrefix}.user_id`)}, true)`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function subjectClaimSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw new Error(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case 'supabase':
      return `((select auth.jwt()) ->> ${quoteLiteral(claim)})`;
    case 'neon':
      return `((select auth.session()) ->> ${quoteLiteral(claim)})`;
    case 'guc':
      return `current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true)`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/** A claim as `jsonb`; the `guc` dialect stores JSON text in `<prefix>.<claim>`. */
export function subjectClaimJsonSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw new Error(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case 'supabase':
      return `((select auth.jwt()) -> ${quoteLiteral(claim)})`;
    case 'neon':
      return `((select auth.session()) -> ${quoteLiteral(claim)})`;
    case 'guc':
      return `nullif(current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true), '')::jsonb`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

function sqlValue(value: ConditionValue, ctx: RlsSqlContext): string {
  if (value !== null && typeof value === 'object' && 'ref' in value) {
    return compileRef(value.ref, ctx);
  }
  if (value !== null && typeof value === 'object' && 'date' in value) {
    return quoteLiteral(value.date);
  }
  if (Array.isArray(value)) {
    return `array[${value.map((item) => sqlValue(item, ctx)).join(', ')}]`;
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'string') {
    return quoteLiteral(value);
  }
  throw new Error('PermDock CLI: non-portable condition value');
}

function compileRef(ref: string, ctx: RlsSqlContext): string {
  if (ref === 'principal.id') {
    return subjectIdSql(ctx);
  }
  const claim =
    ref.startsWith('principal.claim.') || ref.startsWith('principal.claims.')
      ? ref.slice(ref.indexOf('.', ref.indexOf('.') + 1) + 1)
      : undefined;
  if (ref === 'principal.tenant' || claim === ctx.tenantClaim) {
    return tenantClaimSql(ctx);
  }
  if (claim !== undefined) {
    return subjectClaimSql(ctx, claim);
  }
  throw new Error(`PermDock CLI: non-portable subject ref '${ref}'`);
}

function compareSql(
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains',
  field: string,
  value: string,
): string {
  const left = quoteIdent(field);
  switch (op) {
    case 'eq':
      return `${left} = ${value}`;
    case 'ne':
      return `${left} <> ${value}`;
    case 'gt':
      return `${left} > ${value}`;
    case 'gte':
      return `${left} >= ${value}`;
    case 'lt':
      return `${left} < ${value}`;
    case 'lte':
      return `${left} <= ${value}`;
    case 'contains':
      return `${left}::text like '%' || ${value}::text || '%'`;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function existsSql(
  table: RlsMembershipTable,
  rowColumn: string,
  rowField: string,
  roles: readonly string[],
  ctx: RlsSqlContext,
  tenantColumn?: string,
): string {
  const parts = [
    `m.${quoteIdent(rowColumn)} = ${quoteIdent(rowField)}`,
    `m.${quoteIdent(table.user)} = ${subjectIdSql(ctx)}`,
  ];
  if (roles.length > 0) {
    const roleList = roles.map((role) => role.replaceAll("'", "''")).join(',');
    parts.push(`m.${quoteIdent(table.role)} = any('{${roleList}}')`);
  }
  if (table.expiresAt !== undefined) {
    parts.push(
      `(m.${quoteIdent(table.expiresAt)} is null or m.${quoteIdent(table.expiresAt)} > now())`,
    );
  }
  if (tenantColumn !== undefined) {
    parts.push(`m.${quoteIdent(tenantColumn)} = ${tenantClaimSql(ctx)}`);
  }
  return `exists (select 1 from ${quoteTable(table.table)} m where ${parts.join(' and ')})`;
}

function compileMemberOf(
  condition: Extract<Condition, { readonly op: 'memberOf' }>,
  ctx: RlsSqlContext,
): string {
  const mapping =
    condition.scope === 'resource'
      ? condition.resource === undefined
        ? undefined
        : ctx.memberships?.resource?.[condition.resource]
      : ctx.memberships?.[condition.scope];
  if (mapping !== undefined) {
    const rowColumn =
      condition.scope === 'tenant'
        ? mapping.tenant
        : condition.scope === 'team'
          ? mapping.team
          : mapping.id;
    if (rowColumn === undefined) {
      throw new Error(
        `PermDock CLI: memberships mapping for ${condition.scope} is missing the row column`,
      );
    }
    const tenantColumn =
      condition.scope === 'team' ? mapping.tenant : undefined;
    const primary = existsSql(
      mapping,
      rowColumn,
      condition.field,
      condition.roles,
      ctx,
      tenantColumn,
    );
    if (condition.scope !== 'resource' || condition.parents === undefined) {
      return primary;
    }
    const extras = condition.parents.flatMap((parent) => {
      if (typeof parent === 'string') {
        return [
          existsSql(
            mapping,
            rowColumn,
            parent,
            condition.roles,
            ctx,
            tenantColumn,
          ),
        ];
      }
      const hopTable = ctx.memberships?.resource?.[parent.resource];
      return hopTable?.id === undefined
        ? []
        : [
            existsSql(
              hopTable,
              hopTable.id,
              parent.field,
              condition.roles,
              ctx,
            ),
          ];
    });
    return `(${[primary, ...extras].join(' or ')})`;
  }
  if (condition.scope === 'tenant') {
    return `${quoteIdent(condition.field)} = ${tenantClaimSql(ctx)}`;
  }
  throw new Error(
    `PermDock CLI: memberOf ${condition.scope} needs a memberships table mapping`,
  );
}

export function compileConditionSql(
  condition: Condition,
  ctx: RlsSqlContext,
): string {
  switch (condition.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
      return compareSql(
        condition.op,
        condition.field,
        sqlValue(condition.value, ctx),
      );
    case 'in':
    case 'notIn': {
      const keyword = condition.op === 'in' ? 'in' : 'not in';
      if (
        !Array.isArray(condition.value) &&
        typeof condition.value === 'object' &&
        'ref' in condition.value
      ) {
        throw new Error(
          `PermDock CLI: non-portable ${condition.op} against '${condition.value.ref}'`,
        );
      }
      const values = (condition.value as readonly ConditionValue[]).map(
        (item) => sqlValue(item, ctx),
      );
      return `${quoteIdent(condition.field)} ${keyword} (${values.join(', ')})`;
    }
    case 'isNull':
      return `${quoteIdent(condition.field)} is ${condition.value ? '' : 'not '}null`;
    case 'and':
      return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(' and ')})`;
    case 'or':
      if (condition.conditions.length === 0) {
        return 'false';
      }
      return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(' or ')})`;
    case 'not':
      return `not (${compileConditionSql(condition.condition, ctx)})`;
    case 'memberOf':
      return compileMemberOf(condition, ctx);
    case 'sqlFunction':
      if (ctx.inlineFunctions === true) {
        return compileConditionSql(condition.twin, ctx);
      }
      return `${quoteTable(condition.name)}(${condition.args
        .map((arg) =>
          isSqlFunctionField(arg) ? quoteIdent(arg.field) : sqlValue(arg, ctx),
        )
        .join(', ')})`;
    case 'opaque':
      return condition.sql;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

export function parseMembershipsFlag(
  raw: string | undefined,
): RlsMemberships | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const colon = raw.indexOf(':');
  const table = colon === -1 ? raw : raw.slice(0, colon);
  const cols = (colon === -1 ? '' : raw.slice(colon + 1))
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const tenant: RlsMembershipTable = {
    table,
    tenant: cols[0] ?? 'tenant_id',
    user: cols[1] ?? 'user_id',
    role: cols[2] ?? 'role',
    ...(cols[3] === undefined ? {} : { expiresAt: cols[3] }),
  };
  return { tenant };
}

export function andConditions(
  left: Condition | undefined,
  right: Condition | undefined,
): Condition | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return { op: 'and', conditions: [left, right] };
}

export function sqlFunctionNames(
  condition: Condition | undefined,
): readonly string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case 'sqlFunction':
      return [condition.name, ...sqlFunctionNames(condition.twin)];
    case 'and':
    case 'or':
      return condition.conditions.flatMap((child) => sqlFunctionNames(child));
    case 'not':
      return sqlFunctionNames(condition.condition);
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'in':
    case 'notIn':
    case 'isNull':
    case 'memberOf':
    case 'opaque':
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}
