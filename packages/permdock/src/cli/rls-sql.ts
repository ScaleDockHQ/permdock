import type { RelatedCondition } from '../conditions/ast.ts';
import type { Scope } from '../core/scopes.ts';
import type { Condition, ConditionValue, ResourceNode } from '../index.ts';
import type {
  RlsActiveRow,
  RlsDialect,
  RlsMembershipTable,
  RlsMemberships,
  RlsSuspension,
} from './types.ts';

import { scopeColumn, scopeMembershipTable } from '../conditions/compile.ts';
import { type GraphSql, relatedSql } from '../conditions/graph-sql.ts';
import { isReadonlyArray, sole } from '../core/compact.ts';
import { isForbiddenKey } from '../core/paths.ts';
import { resolveScope, rootScope, scopeChain } from '../core/scopes.ts';
import { isSqlFunctionField } from '../index.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLAIM = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RlsSqlContext = {
  readonly dialect: RlsDialect;
  /** The policy's scopes in order (the implicit `tenant` / `team` pair when it declares none). */
  readonly scopes: readonly Scope[];
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
  /** Postgres type of each scope's id column; overrides `tenantType` / `teamType`. */
  readonly scopeTypes?: Readonly<Record<string, string>>;
  /**
   * Set when custom roles compile: the helpers also resolve tenant-defined
   * roles, bounded by the ceiling of `assignable` declared roles.
   */
  readonly customRoles?: {
    readonly declared: readonly string[];
    readonly assignable: readonly string[];
  };
  /** Set when link capabilities compile: resource-scoped grants also get `anon` branches. */
  readonly capabilities?: true;
  /** Role ownership rules (`for`, `assigns`, `min`, `max`, `transferOnly`), when any role declares one. */
  readonly ownership?: RlsOwnership;
  /**
   * Postgres types of the current table's columns, read from the resource
   * schema (`columnTypesOf`). A claim compared with a typed column is cast to
   * that type; a column without an entry compares as text.
   */
  readonly columnTypes?: Readonly<Record<string, string>>;
  /** Array columns of the table, each with its item type: `contains` on one compiles to `v = any(col)`. */
  readonly arrayColumns?: Readonly<Record<string, string>>;
  /** Active-row tables; scope keys are declared names (`checkSuspension` resolves aliases). */
  readonly suspension?: RlsSuspension;
  /** Set when field views compile: grant keys also split by field set. */
  readonly fields?: 'views';
  /** Graph grants: the closure depth kept for each walked resource. */
  readonly graph?: {
    readonly closures: Readonly<Record<string, number>>;
    /** The policy's resources, for link hops. */
    readonly resources?: ReadonlyMap<string, ResourceNode>;
    /** The table of each resource, as `rls.tables` maps it. */
    readonly tables?: Readonly<Record<string, string>>;
  };
};

/** The policy's role ownership rules as the SQL generator needs them. */
export type RlsOwnership = {
  /** Role name to the membership kinds (`via`) that may hold it. */
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  /** Who assigns what: the assigner's scope (or `global`) is the target role's scope or an ancestor of it. */
  readonly assigns: readonly {
    readonly assigner: string;
    readonly scope: string;
    readonly role: string;
  }[];
  /** Roles whose holder count per scope instance is constrained. */
  readonly counted: readonly {
    readonly role: string;
    readonly scope: string;
    readonly min: number;
    readonly max?: number;
    readonly transferOnly: boolean;
  }[];
};

function checkActiveRow(label: string, row: RlsActiveRow): void {
  quoteTable(row.table);
  quoteIdent(row.id);
  if (row.disabledAt !== undefined) {
    quoteIdent(row.disabledAt);
  }
  if (row.status !== undefined) {
    quoteIdent(row.status);
    if (row.active === undefined || row.active.length === 0) {
      throw new Error(
        `PermDock CLI: ${label}.status needs the active values in ${label}.active`,
      );
    }
  }
  if (row.disabledAt === undefined && row.status === undefined) {
    throw new Error(
      `PermDock CLI: ${label} needs disabledAt or status to tell an active row`,
    );
  }
}

/** Validates `rls.suspension` and keys its scopes by declared name. */
export function checkSuspension(
  suspension: RlsSuspension | undefined,
  scopes: readonly Scope[],
): RlsSuspension | undefined {
  if (suspension === undefined) {
    return undefined;
  }
  if (suspension.users !== undefined) {
    checkActiveRow('rls.suspension.users', suspension.users);
  }
  const byName: Record<string, RlsActiveRow> = {};
  for (const [key, row] of Object.entries(suspension.scopes ?? {})) {
    const name = resolveScope(scopes, key);
    if (name === undefined) {
      throw new Error(
        `PermDock CLI: rls.suspension.scopes.${key} names a scope the policy does not declare`,
      );
    }
    checkActiveRow(`rls.suspension.scopes.${key}`, row);
    byName[name] = row;
  }
  return {
    ...(suspension.users === undefined ? {} : { users: suspension.users }),
    ...(Object.keys(byName).length === 0 ? {} : { scopes: byName }),
  };
}

/**
 * `exists` over an active row whose id column equals `id`: a missing row is
 * suspended, so the check fails closed.
 */
export function activeRowSql(row: RlsActiveRow, id: string): string {
  const table = quoteTable(
    row.table.includes('.') ? row.table : `public.${row.table}`,
  );
  const parts = [`s.${quoteIdent(row.id)} = ${id}`];
  if (row.disabledAt !== undefined) {
    parts.push(`s.${quoteIdent(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = (row.active ?? []).map(quoteLiteral).join(', ');
    parts.push(
      `s.${quoteIdent(row.status)}::text = any(array[${values}]::text[])`,
    );
  }
  return `exists (select 1 from ${table} s where ${parts.join(' and ')})`;
}

const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\[\])?$/u;

function sqlType(name: string): string {
  if (!SQL_TYPE.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL type '${name}'`);
  }
  return name;
}

export function tenantTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.tenantType ?? 'uuid');
}

function teamTypeOf(ctx: RlsSqlContext): string {
  return sqlType(ctx.teamType ?? ctx.tenantType ?? 'uuid');
}

/** Postgres type of scope `name`'s id: `scopeTypes`, then the tenant / team type by position. */
export function scopeTypeOf(ctx: RlsSqlContext, name: string): string {
  const declared = ctx.scopeTypes?.[name];
  if (declared !== undefined) {
    return sqlType(declared);
  }
  return name === ctx.scopes[1]?.name ? teamTypeOf(ctx) : tenantTypeOf(ctx);
}

/**
 * A role with `for` counts only on a membership of one of those kinds:
 * `case role when 'admin' then via = any(...) ... else true end`. A missing
 * kind (`viaExpr` null) holds none of them. `undefined` when no role has `for`.
 */
export function kindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
  viaExpr: string,
): string | undefined {
  const kinds = Object.entries(ctx.ownership?.kinds ?? {}).toSorted(
    ([a], [b]) => a.localeCompare(b),
  );
  if (kinds.length === 0) {
    return undefined;
  }
  const arms = kinds.map(
    ([role, allowed]) =>
      `when ${quoteLiteral(role)} then coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(', ')}]::text[])`,
  );
  return `case ${roleExpr} ${arms.join(' ')} else true end`;
}

/** The kind check for one known role; `undefined` when it has no `for`. */
export function roleKindSql(
  ctx: RlsSqlContext,
  role: string,
  viaExpr: string,
): string | undefined {
  const allowed = ctx.ownership?.kinds[role];
  return allowed === undefined
    ? undefined
    : `coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(', ')}]::text[])`;
}

/** Roles with `for` held globally (no membership, so no kind) grant nothing. */
export function globalKindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
): string | undefined {
  const roles = Object.keys(ctx.ownership?.kinds ?? {}).toSorted();
  return roles.length === 0
    ? undefined
    : `not (${roleExpr} = any(array[${roles.map(quoteLiteral).join(', ')}]::text[]))`;
}

/** The closure table graph grants read. Part of the SQL contract. */
export const CLOSURE = {
  table: 'permdock_closure',
} as const;

/** The helper returning the ids of `resource` the subject holds a relation on. */
export function graphHelper(resource: string): string {
  return permittedIdsHelper(resource);
}

/** The helper returning the ids of `resource` whose `link` points into the ids it is given. */
export function linkHelper(resource: string, link: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(link)) {
    throw new Error(
      `PermDock CLI: link '${link}' on ${resource} is not a lowercase SQL name, so rls generate cannot name its helper`,
    );
  }
  permittedIdsHelper(resource);
  return `permdock_link_${resource}_${link}`;
}

/** Graph SQL parts as RLS text: values inline as literals, the subject from the dialect's claim. */
export function graphSqlText(parts: GraphSql, ctx: RlsSqlContext): string {
  return parts
    .map((part) => {
      if ('text' in part) {
        return part.text;
      }
      if ('column' in part) {
        return quoteIdent(part.column);
      }
      if ('subject' in part) {
        return `${subjectIdSql(ctx)}::text`;
      }
      return typeof part.value === 'string'
        ? quoteLiteral(part.value)
        : String(part.value);
    })
    .join('');
}

/** The schema-qualified name of a table under `search_path = ''`. */
export function qualifiedTable(name: string): string {
  return name.includes('.') ? name : `public.${name}`;
}

/** The helper returning the ids of scope `name` a grant key reaches. */
export function permittedIdsHelper(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
    throw new Error(`PermDock CLI: unsafe scope name '${name}'`);
  }
  return `permitted_${name}_ids`;
}

/** The membership table mapped for scope `name`, with the column of its id and of the first scope's id. */
export function scopeTable(
  ctx: RlsSqlContext,
  name: string,
):
  | {
      readonly table: RlsMembershipTable;
      readonly column: string;
      readonly tenantColumn?: string;
    }
  | undefined {
  const table = scopeMembershipTable(ctx.memberships, ctx.scopes, name);
  if (table === undefined) {
    return undefined;
  }
  const column = scopeColumn(table, ctx.scopes, name);
  if (column === undefined) {
    return undefined;
  }
  const root = rootScope(ctx.scopes);
  const tenantColumn =
    root !== undefined && scopeChain(ctx.scopes, name).includes(root)
      ? scopeColumn(table, ctx.scopes, root)
      : undefined;
  return tenantColumn === undefined
    ? { table, column }
    : { table, column, tenantColumn };
}

/** The active-tenant claim cast to the tenant column's type, so the comparison uses the column's index. */
function tenantClaimSql(ctx: RlsSqlContext): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The Postgres type a JSON Schema property compares as; `undefined` for text or an unknown shape. */
function columnTypeOf(property: unknown): string | undefined {
  if (!isRecord(property)) {
    return undefined;
  }
  // SAFETY: find(Array.isArray) returns an array or undefined; its items stay unknown.
  const variants = [property['anyOf'], property['oneOf']].find(
    Array.isArray,
  ) as readonly unknown[] | undefined;
  if (variants !== undefined) {
    const present = variants.filter(
      (item) => !(isRecord(item) && item['type'] === 'null'),
    );
    return present.length === 1 ? columnTypeOf(present[0]) : undefined;
  }
  const types = (
    Array.isArray(property['type']) ? property['type'] : [property['type']]
  ).filter((item) => item !== 'null');
  if (types.length !== 1) {
    return undefined;
  }
  switch (types[0]) {
    case 'integer':
    case 'number':
      return 'numeric';
    case 'boolean':
      return 'boolean';
    case 'string':
      switch (property['format']) {
        case 'date-time':
          return 'timestamptz';
        case 'date':
          return 'date';
        case 'uuid':
          return 'uuid';
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * Column types from a resource's JSON Schema (`~standard.jsonSchema`): numbers
 * compare as `numeric`, booleans as `boolean`, and `date-time`, `date` and
 * `uuid` strings as `timestamptz`, `date` and `uuid`. Other columns are left
 * out and compare as text.
 */
export function columnTypesOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const types: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    const type = isForbiddenKey(name) ? undefined : columnTypeOf(property);
    if (type !== undefined) {
      types[name] = type;
    }
  }
  return types;
}

/**
 * Array columns from a resource's JSON Schema, each with the type its items
 * compare as (`text` when `columnTypesOf` would leave the item out).
 */
export function arrayColumnsOf(
  schema: unknown,
): Readonly<Record<string, string>> {
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  if (!isRecord(properties)) {
    return {};
  }
  const arrays: Record<string, string> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (isForbiddenKey(name) || !isRecord(property)) {
      continue;
    }
    const types = (
      Array.isArray(property['type']) ? property['type'] : [property['type']]
    ).filter((item) => item !== 'null');
    if (types.length === 1 && types[0] === 'array') {
      arrays[name] = columnTypeOf(property['items']) ?? 'text';
    }
  }
  return arrays;
}

const MAX_CLAIM_DEPTH = 8;

/**
 * The claim path of a `principal.claim.*` / `principal.claims.*` ref, one
 * segment per JSON key; `undefined` for any other ref.
 */
export function claimPath(ref: string): readonly string[] | undefined {
  const prefix = ['principal.claim.', 'principal.claims.'].find((item) =>
    ref.startsWith(item),
  );
  if (prefix === undefined) {
    return undefined;
  }
  const segments = ref.slice(prefix.length).split('.');
  if (segments.length > MAX_CLAIM_DEPTH) {
    throw new Error(
      `PermDock CLI: claim path '${ref}' is deeper than ${MAX_CLAIM_DEPTH}`,
    );
  }
  for (const segment of segments) {
    if (!CLAIM.test(segment) || isForbiddenKey(segment)) {
      throw new Error(`PermDock CLI: unsafe claim name '${segment}'`);
    }
  }
  return segments;
}

function jsonPath(
  base: string,
  keys: readonly string[],
  last: '->' | '->>',
): string {
  let sql = base;
  for (const [index, key] of keys.entries()) {
    sql += ` ${index === keys.length - 1 ? last : '->'} ${quoteLiteral(key)}`;
  }
  return sql;
}

/**
 * The JSON document a claim path starts from and the keys to walk in it. The
 * `guc` dialect keeps each top-level claim in its own setting as JSON text.
 */
function claimRoot(
  ctx: RlsSqlContext,
  path: readonly string[],
): { readonly root: string; readonly keys: readonly string[] } {
  const [head, ...rest] = path;
  if (head === undefined) {
    throw new Error('PermDock CLI: empty claim path');
  }
  switch (ctx.dialect) {
    case 'supabase':
      return { root: '(select auth.jwt())', keys: path };
    case 'neon':
      return { root: '(select auth.session())', keys: path };
    case 'guc':
      return { root: subjectClaimJsonSql(ctx, head), keys: rest };
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/** The claim at `path` as `jsonb`. */
function claimJsonSql(ctx: RlsSqlContext, path: readonly string[]): string {
  const { root, keys } = claimRoot(ctx, path);
  return keys.length === 0 ? root : `(${jsonPath(root, keys, '->')})`;
}

/** The claim at `path` as text: `->>` on the last key, or the plain setting for a one-segment `guc` claim. */
function claimTextSql(ctx: RlsSqlContext, path: readonly string[]): string {
  const [head] = path;
  if (path.length === 1 && head !== undefined) {
    return subjectClaimSql(ctx, head);
  }
  const { root, keys } = claimRoot(ctx, path);
  return `(${jsonPath(root, keys, '->>')})`;
}

/** The JSON kind a claim must have to compare with a column of `type`. */
function jsonKindOf(type: string | undefined): 'number' | 'boolean' | 'string' {
  if (type === 'numeric') {
    return 'number';
  }
  return type === 'boolean' ? 'boolean' : 'string';
}

/**
 * A claim compared with a column of `type`. Numbers and booleans must be JSON
 * of that kind (anything else is `null`, so the comparison is false, as in
 * memory); other types cast the text form. A one-segment `guc` claim is text
 * and is cast as is.
 */
function typedClaimSql(
  ctx: RlsSqlContext,
  path: readonly string[],
  type: string | undefined,
): string {
  const text = claimTextSql(ctx, path);
  if (type === undefined || type === 'text') {
    return text;
  }
  const cast = `${text}::${sqlType(type)}`;
  const kind = jsonKindOf(type);
  if (kind === 'string' || (ctx.dialect === 'guc' && path.length === 1)) {
    return `(${cast})`;
  }
  return `(case when jsonb_typeof(${claimJsonSql(ctx, path)}) = '${kind}' then ${cast} end)`;
}

/**
 * The elements of an array claim as a Postgres array of the column's type,
 * built once per statement (an uncorrelated `array(select ...)` is an InitPlan).
 * A missing or non-array claim is the empty array; elements of another JSON
 * kind are left out.
 */
function claimArraySql(
  ctx: RlsSqlContext,
  path: readonly string[],
  type: string | undefined,
): string {
  const json = claimJsonSql(ctx, path);
  const element =
    type === undefined || type === 'text'
      ? `(e #>> '{}')`
      : `(e #>> '{}')::${sqlType(type)}`;
  return `array(select ${element} from jsonb_array_elements(case when jsonb_typeof(${json}) = 'array' then ${json} else '[]'::jsonb end) e where jsonb_typeof(e) = '${jsonKindOf(type)}')`;
}

function sqlValue(
  value: ConditionValue,
  ctx: RlsSqlContext,
  field?: string,
): string {
  if (value !== null && typeof value === 'object' && 'ref' in value) {
    return compileRef(value.ref, ctx, field);
  }
  if (value !== null && typeof value === 'object' && 'date' in value) {
    return quoteLiteral(value.date);
  }
  if (isReadonlyArray(value)) {
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

function compileRef(ref: string, ctx: RlsSqlContext, field?: string): string {
  if (ref === 'principal.id') {
    return subjectIdSql(ctx);
  }
  // Only relation periods compile with it; conditions on the wire carry no clock ref.
  if (ref === 'now') {
    return 'now()';
  }
  const path = claimPath(ref);
  if (
    ref === 'principal.tenant' ||
    (path?.length === 1 && path[0] === ctx.tenantClaim)
  ) {
    return tenantClaimSql(ctx);
  }
  if (path !== undefined) {
    return typedClaimSql(
      ctx,
      path,
      field === undefined ? undefined : ctx.columnTypes?.[field],
    );
  }
  if (ref === 'context' || ref.startsWith('context.')) {
    throw new Error(
      `PermDock CLI: '${ref}' is request context, which is not in the token; RLS cannot read it (permdock doctor PD027)`,
    );
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
    const via =
      table.via === undefined
        ? 'null::text'
        : `m.${quoteIdent(table.via)}::text`;
    const single = sole(roles);
    const kind =
      single === undefined
        ? kindFilterSql(ctx, `m.${quoteIdent(table.role)}::text`, via)
        : roleKindSql(ctx, single, via);
    if (kind !== undefined) {
      parts.push(kind);
    }
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
  const scope =
    condition.scope === 'resource'
      ? undefined
      : resolveScope(ctx.scopes, condition.scope);
  if (condition.scope !== 'resource' && scope === undefined) {
    throw new Error(
      `PermDock CLI: memberOf ${condition.scope} names a scope the policy does not declare`,
    );
  }
  const mapping =
    scope === undefined
      ? condition.resource === undefined
        ? undefined
        : ctx.memberships?.resource?.[condition.resource]
      : scopeMembershipTable(ctx.memberships, ctx.scopes, scope);
  if (mapping !== undefined) {
    const named = scope === undefined ? undefined : scopeTable(ctx, scope);
    const rowColumn = scope === undefined ? mapping.id : named?.column;
    if (rowColumn === undefined) {
      throw new Error(
        `PermDock CLI: memberships mapping for ${condition.scope} is missing the row column`,
      );
    }
    const tenantColumn =
      scope === undefined || scope === rootScope(ctx.scopes)
        ? undefined
        : named?.tenantColumn;
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
  if (scope !== undefined && scope === rootScope(ctx.scopes)) {
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
      return compareSql(
        condition.op,
        condition.field,
        sqlValue(condition.value, ctx, condition.field),
      );
    case 'contains': {
      const element = ctx.arrayColumns?.[condition.field];
      if (element !== undefined) {
        const value = sqlValue(
          condition.value,
          {
            ...ctx,
            columnTypes: { ...ctx.columnTypes, [condition.field]: element },
          },
          condition.field,
        );
        return `${value} = any(${quoteIdent(condition.field)})`;
      }
      return compareSql(
        condition.op,
        condition.field,
        sqlValue(condition.value, ctx, condition.field),
      );
    }
    case 'in':
    case 'notIn': {
      const keyword = condition.op === 'in' ? 'in' : 'not in';
      if (
        !Array.isArray(condition.value) &&
        typeof condition.value === 'object' &&
        'ref' in condition.value
      ) {
        const path = claimPath(condition.value.ref);
        if (path === undefined) {
          compileRef(condition.value.ref, ctx);
          throw new Error(
            `PermDock CLI: non-portable ${condition.op} against '${condition.value.ref}'`,
          );
        }
        const column = quoteIdent(condition.field);
        const list = claimArraySql(
          ctx,
          path,
          ctx.columnTypes?.[condition.field],
        );
        return condition.op === 'in'
          ? `${column} = any (${list})`
          : `(${column} is not null and not (${column} = any (${list})))`;
      }
      // SAFETY: an in / notIn value is a list or a ref, and the ref case returned above.
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
    case 'related':
      return compileRelatedSql(condition, ctx);
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

function valueContextRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(valueContextRefs);
  }
  if (
    isRecord(value) &&
    typeof value['ref'] === 'string' &&
    (value['ref'] === 'context' || value['ref'].startsWith('context.'))
  ) {
    return [value['ref']];
  }
  return [];
}

/**
 * The `context.*` refs a condition reads. The request context is not in the
 * token, so RLS cannot evaluate them.
 */
export function contextRefs(
  condition: Condition | undefined,
): readonly string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'in':
    case 'notIn':
      return valueContextRefs(condition.value);
    case 'and':
    case 'or':
      return condition.conditions.flatMap((child) => contextRefs(child));
    case 'not':
      return contextRefs(condition.condition);
    case 'sqlFunction':
      return [
        ...condition.args.flatMap(valueContextRefs),
        ...contextRefs(condition.twin),
      ];
    case 'isNull':
    case 'memberOf':
    case 'related':
    case 'opaque':
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
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
    case 'related':
    case 'opaque':
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * A `related` condition as uncorrelated subqueries, so Postgres runs the
 * helper once per statement: the row's field in the closure's descendants of
 * the ids the subject holds the relation on (or those ids alone at depth 0).
 * The helper sits in `array(...)` so it stays an InitPlan; a plain `in` gets
 * pulled into a join that can rescan it per closure row.
 */
function compileRelatedSql(
  condition: RelatedCondition,
  ctx: RlsSqlContext,
): string {
  if (condition.hops !== undefined && condition.hops.length > 0) {
    return compileHoppedSql(condition, ctx);
  }
  const type = ctx.columnTypes?.[condition.field];
  const cast = type === undefined || type === 'text' ? '' : `::${type}`;
  const column =
    type === undefined
      ? `${quoteIdent(condition.field)}::text`
      : quoteIdent(condition.field);
  const helper = `${`${quoteIdent(ctx.schema ?? 'public')}.${graphHelper(condition.resource)}`}(${quoteLiteral(condition.relation)})`;
  const cap = ctx.graph?.closures[condition.resource];
  let inner: string;
  if (condition.depth > 0 && cap !== undefined) {
    const depth =
      condition.depth < cap ? ` and depth <= ${String(condition.depth)}` : '';
    inner = `select descendant${cast} from ${`${quoteIdent(ctx.schema ?? 'public')}.${CLOSURE.table}`} where resource = ${quoteLiteral(condition.resource)}${depth} and ancestor = any (array(select ${helper}))`;
  } else {
    inner =
      cast === ''
        ? `select ${helper}`
        : `select p.id${cast} from ${helper} as p(id)`;
  }
  const reach = `${column} in (${inner})`;
  if (condition.parent === true && condition.restricted !== undefined) {
    return `(${reach} and ${quoteIdent(condition.restricted)} is not true)`;
  }
  return reach;
}

/**
 * A `related` condition that crosses link hops: the reached instances of the
 * last resource, carried back over each link by its security definer helper,
 * so the hop reads a table the subject may not see.
 */
function compileHoppedSql(
  condition: RelatedCondition,
  ctx: RlsSqlContext,
): string {
  const resources = ctx.graph?.resources;
  if (resources === undefined) {
    throw new Error(
      'PermDock CLI: a related condition with link hops needs the policy resources in the RLS context',
    );
  }
  const schema = quoteIdent(ctx.schema ?? 'public');
  return graphSqlText(
    relatedSql(condition, {
      resources,
      ...(ctx.graph?.tables === undefined ? {} : { tables: ctx.graph.tables }),
      closure: `${ctx.schema ?? 'public'}.${CLOSURE.table}`,
      closureDepths: ctx.graph?.closures ?? {},
      qualify: qualifiedTable,
      holders: (resource, relation) => [
        {
          text: `select ${schema}.${graphHelper(resource)}(${quoteLiteral(relation)})`,
        },
      ],
      linked: (resource, link, targets) => [
        {
          text: `select ${schema}.${linkHelper(resource, link)}(array(`,
        },
        ...targets,
        { text: '))' },
      ],
    }),
    ctx,
  );
}
