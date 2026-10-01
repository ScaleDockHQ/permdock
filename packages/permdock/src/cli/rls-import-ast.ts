import { createHash } from 'node:crypto';
import { deparse, parse } from 'pgsql-parser';

import type { Condition, ConditionValue, SqlFunctionArg } from '../index.ts';
import type { HelperScope, RolePermission } from './rls-helpers.ts';
import type { RlsFunctionMapping, RlsMemberships } from './types.ts';

import { HELPERS } from './rls-helpers.ts';

type PgNode = Record<string, unknown>;

function asNode(value: unknown): PgNode | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    // SAFETY: checked to be a non-null, non-array object, which is all PgNode claims.
    return value as PgNode;
  }
  return undefined;
}

function stringVal(value: unknown): string | undefined {
  const node = asNode(value);
  if (node === undefined) {
    return undefined;
  }
  const inner = asNode(node['String']);
  if (inner !== undefined) {
    if (typeof inner['sval'] === 'string') {
      return inner['sval'];
    }
    if (typeof inner['str'] === 'string') {
      return inner['str'];
    }
  }
  if (typeof node['str'] === 'string') {
    return node['str'];
  }
  if (typeof node['sval'] === 'string') {
    return node['sval'];
  }
  return undefined;
}

function unwrap(value: unknown): unknown {
  const node = asNode(value);
  if (node === undefined) {
    return value;
  }
  const cast = asNode(node['TypeCast']);
  if (cast !== undefined) {
    return unwrap(cast['arg']);
  }
  return value;
}

function columnName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const ref = asNode(node?.['ColumnRef']);
  const fields = ref?.['fields'];
  if (!Array.isArray(fields) || fields.length === 0) {
    return undefined;
  }
  return stringVal(fields.at(-1));
}

function funcName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const call = asNode(node?.['FuncCall']);
  const names = call?.['funcname'];
  if (!Array.isArray(names) || names.length === 0) {
    return undefined;
  }
  return names.map((item) => stringVal(item) ?? '').join('.');
}

/** The expression of a scalar `(select <expr>)`, the InitPlan form generate writes. */
function scalarSubselect(value: unknown): unknown {
  const sub = asNode(asNode(unwrap(value))?.['SubLink']);
  const select = asNode(asNode(sub?.['subselect'])?.['SelectStmt']);
  const targets = select?.['targetList'];
  if (!Array.isArray(targets) || targets[0] === undefined) {
    return undefined;
  }
  return asNode(asNode(targets[0])?.['ResTarget'])?.['val'];
}

function isAuthUid(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isAuthUid(inner);
  }
  const name = funcName(value);
  return (
    name === 'auth.uid' ||
    name === 'auth.user_id' ||
    name === 'uid' ||
    name === 'user_id'
  );
}

function isCurrentSettingUserId(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isCurrentSettingUserId(inner);
  }
  const name = funcName(value);
  if (name !== 'current_setting') {
    return false;
  }
  const node = asNode(unwrap(value));
  const args = asNode(node?.['FuncCall'])?.['args'];
  if (!Array.isArray(args) || args[0] === undefined) {
    return false;
  }
  const literal = constValue(args[0]);
  return typeof literal === 'string' && literal.endsWith('.user_id');
}

function constValue(value: unknown): ConditionValue | undefined {
  const node = asNode(unwrap(value));
  const constant = asNode(node?.['A_Const']);
  if (constant === undefined) {
    return undefined;
  }
  if (constant['isnull'] === true) {
    return null;
  }
  const sval = asNode(constant['sval']);
  if (sval !== undefined && typeof sval['sval'] === 'string') {
    return sval['sval'];
  }
  if (typeof constant['sval'] === 'string') {
    return constant['sval'];
  }
  // The parser omits a protobuf default, so `0` and `false` arrive as `{}`.
  const ival = asNode(constant['ival']);
  if (ival !== undefined) {
    const number = ival['ival'] ?? 0;
    return typeof number === 'number' ? number : undefined;
  }
  if (typeof constant['ival'] === 'number') {
    return constant['ival'];
  }
  const boolval = asNode(constant['boolval']);
  if (boolval !== undefined) {
    const flag = boolval['boolval'] ?? false;
    return typeof flag === 'boolean' ? flag : undefined;
  }
  if (typeof constant['boolval'] === 'boolean') {
    return constant['boolval'];
  }
  return undefined;
}

function selectFromTable(selectNode: unknown): string | undefined {
  const select = asNode(asNode(selectNode)?.['SelectStmt']);
  const from = select?.['fromClause'];
  if (!Array.isArray(from) || from[0] === undefined) {
    return undefined;
  }
  const range = asNode(asNode(from[0])?.['RangeVar']);
  const relname = range?.['relname'];
  return typeof relname === 'string' ? relname : undefined;
}

function sublinkTable(
  value: unknown,
  kinds: ReadonlySet<string | number>,
): string | undefined {
  const node = asNode(unwrap(value));
  const sub = asNode(node?.['SubLink']);
  if (sub === undefined) {
    return undefined;
  }
  const kind = sub['subLinkType'];
  // SAFETY: Set.has only compares by identity, so a kind of any other type just misses.
  if (kind === undefined || !kinds.has(kind as string | number)) {
    return undefined;
  }
  return selectFromTable(sub['subselect']);
}

function membershipTable(value: unknown): string | undefined {
  const exists = sublinkTable(value, new Set(['EXISTS_SUBLINK', 0]));
  if (exists !== undefined) {
    return exists;
  }
  const anyDirect = sublinkTable(
    value,
    new Set(['ANY_SUBLINK', 'IN_SUBLINK', 2]),
  );
  if (anyDirect !== undefined) {
    return anyDirect;
  }
  const node = asNode(unwrap(value));
  const expr = asNode(node?.['A_Expr']);
  if (expr === undefined) {
    return undefined;
  }
  const right = unwrap(expr['rexpr']);
  const fromRight = sublinkTable(
    right,
    new Set(['ANY_SUBLINK', 'IN_SUBLINK', 'EXISTS_SUBLINK', 0, 2]),
  );
  if (fromRight !== undefined) {
    return fromRight;
  }
  if (Array.isArray(expr['rexpr']) && expr['rexpr'][0] !== undefined) {
    return selectFromTable(expr['rexpr'][0]);
  }
  return undefined;
}

function operatorName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.['A_Expr']);
  const names = expr?.['name'];
  if (!Array.isArray(names) || names[0] === undefined) {
    return undefined;
  }
  return stringVal(names[0]);
}

function boolOp(value: unknown): 'and' | 'or' | 'not' | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.['BoolExpr']);
  const op = expr?.['boolop'];
  if (op === 'AND_EXPR' || op === 0) {
    return 'and';
  }
  if (op === 'OR_EXPR' || op === 1) {
    return 'or';
  }
  if (op === 'NOT_EXPR' || op === 2) {
    return 'not';
  }
  return undefined;
}

function functionLookupName(
  name: string,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
): RlsFunctionMapping | undefined {
  if (functions === undefined) {
    return undefined;
  }
  if (functions[name] !== undefined) {
    return functions[name];
  }
  const short = name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1)
    : name;
  return functions[short];
}

function argFromNode(value: unknown): SqlFunctionArg | undefined {
  const field = columnName(value);
  if (field !== undefined) {
    return { field };
  }
  if (isAuthUid(value) || isCurrentSettingUserId(value)) {
    return { ref: 'principal.id' };
  }
  return constValue(value);
}

export async function canonicalDump(sql: string): Promise<string | undefined> {
  try {
    return await deparse(await parse(sql));
  } catch {
    return undefined;
  }
}

function asStmts(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const node = asNode(parsed);
  if (Array.isArray(node?.['stmts'])) {
    return node['stmts'];
  }
  return [];
}

export async function fingerprintSql(sql: string): Promise<string> {
  try {
    const parsed = await parse(`SELECT 1 WHERE (${sql})`);
    const deparsed = await deparse(parsed);
    return createHash('sha256').update(deparsed).digest('hex').slice(0, 16);
  } catch {
    return createHash('sha256')
      .update(sql.replaceAll(/\s+/g, ' ').trim().toLowerCase())
      .digest('hex')
      .slice(0, 16);
  }
}

export async function conditionFromAst(
  sql: string | undefined,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  unmapped: string[],
  joins: string[] = [],
  seeds: readonly RolePermission[] = [],
): Promise<unknown> {
  if (sql === undefined || sql.trim() === '' || sql.trim() === 'true') {
    return { op: 'eq', field: '_', value: true };
  }
  const where = await whereOf(sql);
  if (where === undefined) {
    return { op: 'opaque', sql, fingerprint: await fingerprintSql(sql) };
  }
  const mapped = mapNode(where, {
    memberships,
    functions,
    unmapped,
    joins,
    seeds,
  });
  if (mapped === undefined) {
    return { op: 'opaque', sql, fingerprint: await fingerprintSql(sql) };
  }
  return mapped;
}

async function whereOf(sql: string): Promise<unknown> {
  try {
    const parsed = await parse(`SELECT 1 WHERE (${sql})`);
    const first = asNode(asStmts(parsed)[0]);
    const raw = asNode(nodeStmt(first));
    return asNode(raw?.['SelectStmt'])?.['whereClause'];
  } catch {
    return undefined;
  }
}

type MapContext = {
  readonly memberships: RlsMemberships | undefined;
  readonly functions: Readonly<Record<string, RlsFunctionMapping>> | undefined;
  readonly unmapped: string[];
  readonly joins: string[];
  readonly seeds: readonly RolePermission[];
};

/** A call to one of the generated RLS helpers (`permdock_has`, `permitted_<scope>_ids`), in either policy shape. */
export type HelperCall = {
  readonly scope: HelperScope;
  readonly key: string;
  readonly column?: string;
};

const PERMITTED = /^permitted_([a-z][a-z0-9_]*)_ids$/u;

function helperScope(name: string | undefined): HelperScope | undefined {
  if (name === undefined) {
    return undefined;
  }
  const bare = name.slice(name.lastIndexOf('.') + 1);
  if (bare === HELPERS.has) {
    return 'global';
  }
  return PERMITTED.exec(bare)?.[1];
}

function helperKey(call: unknown): string | undefined {
  const args = asNode(asNode(unwrap(call))?.['FuncCall'])?.['args'];
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const key = constValue(args[0]);
  return typeof key === 'string' ? key : undefined;
}

function helperCall(value: unknown): HelperCall | undefined {
  const node = asNode(unwrap(value));
  const sub = asNode(node?.['SubLink']);
  if (sub === undefined) {
    const scope = helperScope(funcName(node));
    const key = helperKey(node);
    return scope === 'global' && key !== undefined ? { scope, key } : undefined;
  }
  const targets = asNode(asNode(sub['subselect'])?.['SelectStmt'])?.[
    'targetList'
  ];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return undefined;
  }
  const call = asNode(asNode(targets[0])?.['ResTarget'])?.['val'];
  const scope = helperScope(funcName(call));
  const key = helperKey(call);
  if (scope === undefined || key === undefined) {
    return undefined;
  }
  const kind = sub['subLinkType'];
  if (scope === 'global') {
    return kind === 'EXPR_SUBLINK' || kind === 4 ? { scope, key } : undefined;
  }
  const column = columnName(sub['testexpr']);
  return (kind === 'ANY_SUBLINK' || kind === 2) && column !== undefined
    ? { scope, key, column }
    : undefined;
}

const MEMBER = /^member_([a-z][a-z0-9_]*)_ids$/u;

/** `col in (select member_<scope>_ids())`: any live membership of the row's instance. */
function memberCall(
  value: unknown,
): { readonly scope: string; readonly column: string } | undefined {
  const sub = asNode(asNode(unwrap(value))?.['SubLink']);
  const kind = sub?.['subLinkType'];
  if (sub === undefined || (kind !== 'ANY_SUBLINK' && kind !== 2)) {
    return undefined;
  }
  const targets = asNode(asNode(sub['subselect'])?.['SelectStmt'])?.[
    'targetList'
  ];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return undefined;
  }
  const call = asNode(asNode(targets[0])?.['ResTarget'])?.['val'];
  const name = funcName(asNode(unwrap(call)));
  const args = asNode(asNode(unwrap(call))?.['FuncCall'])?.['args'];
  const scope =
    name === undefined
      ? undefined
      : MEMBER.exec(name.slice(name.lastIndexOf('.') + 1))?.[1];
  const column = columnName(sub['testexpr']);
  return scope === undefined ||
    column === undefined ||
    (Array.isArray(args) && args.length > 0)
    ? undefined
    : { scope, column };
}

function rolesFor(
  seeds: readonly RolePermission[],
  key: string,
  scope: HelperScope,
): readonly string[] {
  return [
    ...new Set(
      seeds
        .filter((seed) => seed.grantKey === key && seed.scope === scope)
        .map((seed) => seed.role),
    ),
  ];
}

function helperCondition(
  call: HelperCall,
  seeds: readonly RolePermission[],
): Condition {
  const roles = rolesFor(seeds, call.key, call.scope);
  if (call.scope === 'global' || call.column === undefined) {
    // A global role has no row form: keep it verbatim, and name its roles in `grants`.
    const sql = `(select ${HELPERS.has}(${quoteSqlLiteral(call.key)}))`;
    return {
      op: 'opaque',
      sql,
      fingerprint: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    };
  }
  return {
    op: 'memberOf',
    scope: call.scope,
    field: call.column,
    roles: [...roles],
  };
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** One role-gated branch of an imported policy: which roles, at which scope, under which row condition. */
export type ImportedGrant = {
  readonly key: string;
  readonly permission: string;
  readonly scope: HelperScope;
  readonly roles: readonly string[];
  readonly where?: Condition;
};

function flatten(value: unknown, op: 'and' | 'or'): readonly unknown[] {
  if (boolOp(value) !== op) {
    return [value];
  }
  const args = asNode(asNode(unwrap(value))?.['BoolExpr'])?.['args'];
  return Array.isArray(args) ? args.flatMap((arg) => flatten(arg, op)) : [];
}

function helperCalls(conjunct: unknown): readonly HelperCall[] | undefined {
  const calls = flatten(conjunct, 'or').map(helperCall);
  // SAFETY: every() above checked that no call is undefined.
  return calls.every((call) => call !== undefined)
    ? (calls as readonly HelperCall[])
    : undefined;
}

/**
 * The role structure of a policy that calls the helpers: each OR branch's
 * helper calls become grants (roles from the `role_permissions` seeds), the
 * branch's other conjuncts become their `where`. Restrictive policies are
 * read through their outer `not`.
 */
export async function helperGrants(
  sql: string | undefined,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  seeds: readonly RolePermission[],
): Promise<readonly ImportedGrant[]> {
  if (sql === undefined) {
    return [];
  }
  let where = await whereOf(sql);
  if (boolOp(where) === 'not') {
    where = asNode(asNode(unwrap(where))?.['BoolExpr'])?.['args'];
    where = Array.isArray(where) ? where[0] : undefined;
  }
  const unportable: Condition = {
    op: 'opaque',
    sql,
    fingerprint: await fingerprintSql(sql),
  };
  const grants: ImportedGrant[] = [];
  for (const branch of flatten(where, 'or')) {
    const conjuncts = flatten(branch, 'and');
    const calls: HelperCall[] = [];
    const rest: Condition[] = [];
    let portable = true;
    for (const conjunct of conjuncts) {
      const found = helperCalls(conjunct);
      if (found !== undefined) {
        calls.push(...found);
        continue;
      }
      const mapped = mapNode(conjunct, {
        memberships,
        functions,
        unmapped: [],
        joins: [],
        seeds,
      });
      if (mapped === undefined) {
        portable = false;
      } else {
        rest.push(mapped);
      }
    }
    if (calls.length === 0) {
      continue;
    }
    const condition: Condition | undefined = !portable
      ? unportable
      : rest.length === 0
        ? undefined
        : rest.length === 1
          ? rest[0]
          : { op: 'and', conditions: rest };
    for (const call of calls) {
      const permission =
        seeds.find((seed) => seed.grantKey === call.key)?.permission ??
        call.key.replace(/#\d+$/u, '');
      grants.push({
        key: call.key,
        permission,
        scope: call.scope,
        roles: rolesFor(seeds, call.key, call.scope),
        ...(condition === undefined ? {} : { where: condition }),
      });
    }
  }
  return grants;
}

const SEED_COLUMNS = [
  'role',
  'permission',
  'grant_key',
  'scope',
  'effect',
] as const;

function asScope(value: unknown): HelperScope | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/u.test(value)
    ? value
    : undefined;
}

export function seedFromRow(
  row: Readonly<Record<string, unknown>>,
): RolePermission | undefined {
  const scope = asScope(row['scope']);
  if (
    typeof row['role'] !== 'string' ||
    typeof row['permission'] !== 'string' ||
    typeof row['grant_key'] !== 'string' ||
    scope === undefined
  ) {
    return undefined;
  }
  return {
    role: row['role'],
    permission: row['permission'],
    grantKey: row['grant_key'],
    scope,
    effect: row['effect'] === 'deny' ? 'deny' : 'allow',
  };
}

/** `role_permissions` rows from the `insert ... values` statements of a SQL dump. */
export async function seedsFromSql(
  sql: string,
): Promise<readonly RolePermission[]> {
  let parsed: unknown;
  try {
    parsed = await parse(sql);
  } catch {
    return [];
  }
  const seeds: RolePermission[] = [];
  for (const item of asStmts(parsed)) {
    const insert = asNode(asNode(nodeStmt(asNode(item)))?.['InsertStmt']);
    if (asNode(insert?.['relation'])?.['relname'] !== 'role_permissions') {
      continue;
    }
    const cols = Array.isArray(insert?.['cols'])
      ? insert['cols'].map(
          (col) => asNode(asNode(col)?.['ResTarget'])?.['name'],
        )
      : [];
    const values = asNode(asNode(insert?.['selectStmt'])?.['SelectStmt'])?.[
      'valuesLists'
    ];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const list of values) {
      const items = asNode(asNode(list)?.['List'])?.['items'];
      if (!Array.isArray(items)) {
        continue;
      }
      const row: Record<string, unknown> = {};
      for (const [index, col] of cols.entries()) {
        if (
          typeof col === 'string' &&
          // SAFETY: widening the column union to string only lets includes() accept a parsed name.
          (SEED_COLUMNS as readonly string[]).includes(col)
        ) {
          row[col] = constValue(items[index]);
        }
      }
      const seed = seedFromRow(row);
      if (seed !== undefined) {
        seeds.push(seed);
      }
    }
  }
  return seeds;
}

function nodeStmt(first: PgNode | undefined): unknown {
  const raw = asNode(first?.['RawStmt']);
  if (raw !== undefined) {
    return raw['stmt'];
  }
  return first?.['stmt'];
}

function mapNode(value: unknown, ctx: MapContext): Condition | undefined {
  if (value === undefined) {
    return undefined;
  }
  const node = asNode(unwrap(value));
  if (node === undefined) {
    return undefined;
  }
  const { memberships, functions, unmapped, joins } = ctx;
  const member = memberCall(node);
  if (member !== undefined) {
    return {
      op: 'memberOf',
      scope: member.scope,
      field: member.column,
      roles: [],
    };
  }
  const helper = helperCall(node);
  if (helper !== undefined) {
    return helperCondition(helper, ctx.seeds);
  }
  const nullTest = asNode(node['NullTest']);
  if (nullTest !== undefined) {
    const field = columnName(nullTest['arg']);
    if (field === undefined) {
      return undefined;
    }
    const isNull =
      nullTest['nulltesttype'] === 'IS_NULL' ||
      nullTest['nulltesttype'] === 0 ||
      nullTest['nulltesttype'] === undefined;
    return { op: 'isNull', field, value: isNull };
  }
  const compound = boolOp(node);
  if (compound !== undefined) {
    const expr = asNode(node['BoolExpr']);
    const args = expr?.['args'];
    if (!Array.isArray(args)) {
      return undefined;
    }
    if (compound === 'not') {
      const inner = mapNode(args[0], ctx);
      return inner === undefined ? undefined : { op: 'not', condition: inner };
    }
    const children = args
      .map((arg) => mapNode(arg, ctx))
      .filter((item): item is Condition => item !== undefined);
    if (children.length !== args.length) {
      return undefined;
    }
    return { op: compound, conditions: children };
  }
  const table = membershipTable(node);
  if (table !== undefined) {
    for (const [scope, mapped] of Object.entries(memberships?.scopes ?? {})) {
      const column = mapped.columns?.[scope];
      if (mapped.table === table && column !== undefined) {
        return { op: 'memberOf', scope, field: column, roles: [] };
      }
    }
    if (memberships?.tenant?.table === table) {
      return {
        op: 'memberOf',
        scope: 'tenant',
        field: memberships.tenant.tenant ?? 'tenant_id',
        roles: [],
      };
    }
    if (memberships?.team?.table === table) {
      return {
        op: 'memberOf',
        scope: 'team',
        field: memberships.team.team ?? 'team_id',
        roles: [],
      };
    }
    joins.push(table);
    return undefined;
  }
  const name = funcName(node);
  if (name !== undefined && !isAuthUid(node) && name !== 'current_setting') {
    const mapping = functionLookupName(name, functions);
    if (mapping === undefined) {
      unmapped.push(name);
      return undefined;
    }
    const call = asNode(node['FuncCall']);
    const rawArgs = Array.isArray(call?.['args']) ? call['args'] : [];
    const args: SqlFunctionArg[] =
      mapping.args?.map((field) => ({ field })) ??
      rawArgs
        .map((arg) => argFromNode(arg))
        .filter((item): item is SqlFunctionArg => item !== undefined);
    // SAFETY: twin comes from the project's own rls.functions config, which documents it as a Condition.
    return {
      op: 'sqlFunction',
      name,
      args,
      twin: mapping.twin as Condition,
    };
  }
  const op = operatorName(node);
  const expr = asNode(node['A_Expr']);
  if (
    op === '=' ||
    op === '<>' ||
    op === '>' ||
    op === '>=' ||
    op === '<' ||
    op === '<='
  ) {
    const left = columnName(expr?.['lexpr']) ?? columnName(expr?.['rexpr']);
    const right = expr?.['lexpr'];
    const leftIsColumn = columnName(expr?.['lexpr']) !== undefined;
    const other = leftIsColumn ? expr?.['rexpr'] : right;
    if (left === undefined) {
      return undefined;
    }
    const comparison =
      op === '='
        ? 'eq'
        : op === '<>'
          ? 'ne'
          : op === '>'
            ? 'gt'
            : op === '>='
              ? 'gte'
              : op === '<'
                ? 'lt'
                : 'lte';
    if (isAuthUid(other) || isCurrentSettingUserId(other)) {
      return { op: comparison, field: left, value: { ref: 'principal.id' } };
    }
    const literal = constValue(other);
    if (literal === undefined) {
      const claim = jwtClaim(other);
      if (claim !== undefined) {
        return {
          op: comparison,
          field: left,
          value: { ref: `principal.claim.${claim}` },
        };
      }
      return undefined;
    }
    return { op: comparison, field: left, value: literal };
  }
  return undefined;
}

function jwtClaim(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.['A_Expr']);
  if (expr === undefined) {
    return undefined;
  }
  const name = operatorName(node);
  if ((name !== '->>' && name !== '->') || !isJwtCall(expr['lexpr'])) {
    return undefined;
  }
  const claim = constValue(expr['rexpr']);
  return typeof claim === 'string' ? claim : undefined;
}

/** `auth.jwt()` / `auth.session()`, bare or as a scalar `(select …)`; a column's `->>` is row data, not a claim. */
function isJwtCall(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isJwtCall(inner);
  }
  const name = funcName(value);
  return name === 'auth.jwt' || name === 'auth.session';
}
