import type { Condition, ConditionValue, SqlFunctionArg } from 'permdock';

import { createHash } from 'node:crypto';
import { deparse, parse } from 'pgsql-parser';

import type { RlsFunctionMapping, RlsMemberships } from './types.ts';

type PgNode = Record<string, unknown>;

function asNode(value: unknown): PgNode | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as PgNode;
  }
  return undefined;
}

function stringVal(value: unknown): string | undefined {
  const node = asNode(value);
  if (node === undefined) {
    return undefined;
  }
  const inner = asNode(node.String);
  if (inner !== undefined) {
    if (typeof inner.sval === 'string') {
      return inner.sval;
    }
    if (typeof inner.str === 'string') {
      return inner.str;
    }
  }
  if (typeof node.str === 'string') {
    return node.str;
  }
  if (typeof node.sval === 'string') {
    return node.sval;
  }
  return undefined;
}

function unwrap(value: unknown): unknown {
  const node = asNode(value);
  if (node === undefined) {
    return value;
  }
  const cast = asNode(node.TypeCast);
  if (cast !== undefined) {
    return unwrap(cast.arg);
  }
  return value;
}

function columnName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const ref = asNode(node?.ColumnRef);
  const fields = ref?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return undefined;
  }
  return stringVal(fields.at(-1));
}

function funcName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const call = asNode(node?.FuncCall);
  const names = call?.funcname;
  if (!Array.isArray(names) || names.length === 0) {
    return undefined;
  }
  return names.map((item) => stringVal(item) ?? '').join('.');
}

function isAuthUid(value: unknown): boolean {
  const node = asNode(unwrap(value));
  if (node === undefined) {
    return false;
  }
  const sub = asNode(node.SubLink);
  if (sub !== undefined) {
    const select = asNode(asNode(sub.subselect)?.SelectStmt);
    const targets = select?.targetList;
    if (Array.isArray(targets) && targets[0] !== undefined) {
      const res = asNode(asNode(targets[0])?.ResTarget);
      return isAuthUid(res?.val);
    }
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
  const name = funcName(value);
  if (name !== 'current_setting') {
    return false;
  }
  const node = asNode(unwrap(value));
  const args = asNode(node?.FuncCall)?.args;
  if (!Array.isArray(args) || args[0] === undefined) {
    return false;
  }
  const literal = constValue(args[0]);
  return typeof literal === 'string' && literal.endsWith('.user_id');
}

function constValue(value: unknown): ConditionValue | undefined {
  const node = asNode(unwrap(value));
  const constant = asNode(node?.A_Const);
  if (constant === undefined) {
    return undefined;
  }
  if (constant.isnull === true) {
    return null;
  }
  const sval = asNode(constant.sval);
  if (sval !== undefined && typeof sval.sval === 'string') {
    return sval.sval;
  }
  if (typeof constant.sval === 'string') {
    return constant.sval;
  }
  const ival = asNode(constant.ival);
  if (ival !== undefined && typeof ival.ival === 'number') {
    return ival.ival;
  }
  if (typeof constant.ival === 'number') {
    return constant.ival;
  }
  const boolval = asNode(constant.boolval);
  if (boolval !== undefined && typeof boolval.boolval === 'boolean') {
    return boolval.boolval;
  }
  if (typeof constant.boolval === 'boolean') {
    return constant.boolval;
  }
  return undefined;
}

function selectFromTable(selectNode: unknown): string | undefined {
  const select = asNode(asNode(selectNode)?.SelectStmt);
  const from = select?.fromClause;
  if (!Array.isArray(from) || from[0] === undefined) {
    return undefined;
  }
  const range = asNode(asNode(from[0])?.RangeVar);
  const relname = range?.relname;
  return typeof relname === 'string' ? relname : undefined;
}

function sublinkTable(
  value: unknown,
  kinds: ReadonlySet<string | number>,
): string | undefined {
  const node = asNode(unwrap(value));
  const sub = asNode(node?.SubLink);
  if (sub === undefined) {
    return undefined;
  }
  const kind = sub.subLinkType;
  if (kind === undefined || !kinds.has(kind as string | number)) {
    return undefined;
  }
  return selectFromTable(sub.subselect);
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
  const expr = asNode(node?.A_Expr);
  if (expr === undefined) {
    return undefined;
  }
  const right = unwrap(expr.rexpr);
  const fromRight = sublinkTable(
    right,
    new Set(['ANY_SUBLINK', 'IN_SUBLINK', 'EXISTS_SUBLINK', 0, 2]),
  );
  if (fromRight !== undefined) {
    return fromRight;
  }
  if (Array.isArray(expr.rexpr) && expr.rexpr[0] !== undefined) {
    return selectFromTable(expr.rexpr[0]);
  }
  return undefined;
}

function operatorName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.A_Expr);
  const names = expr?.name;
  if (!Array.isArray(names) || names[0] === undefined) {
    return undefined;
  }
  return stringVal(names[0]);
}

function boolOp(value: unknown): 'and' | 'or' | 'not' | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.BoolExpr);
  const op = expr?.boolop;
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
  if (Array.isArray(node?.stmts)) {
    return node.stmts;
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
): Promise<unknown> {
  if (sql === undefined || sql.trim() === '' || sql.trim() === 'true') {
    return { op: 'eq', field: '_', value: true };
  }
  let where: unknown;
  try {
    const parsed = await parse(`SELECT 1 WHERE (${sql})`);
    const first = asNode(asStmts(parsed)[0]);
    const raw = asNode(nodeStmt(first));
    const select = asNode(raw?.SelectStmt);
    where = select?.whereClause;
  } catch {
    return { op: 'opaque', sql, fingerprint: await fingerprintSql(sql) };
  }
  const mapped = mapNode(where, memberships, functions, unmapped, joins);
  if (mapped === undefined) {
    return { op: 'opaque', sql, fingerprint: await fingerprintSql(sql) };
  }
  return mapped;
}

function nodeStmt(first: PgNode | undefined): unknown {
  const raw = asNode(first?.RawStmt);
  if (raw !== undefined) {
    return raw.stmt;
  }
  return first?.stmt;
}

function mapNode(
  value: unknown,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  unmapped: string[],
  joins: string[],
): Condition | undefined {
  if (value === undefined) {
    return undefined;
  }
  const node = asNode(unwrap(value));
  if (node === undefined) {
    return undefined;
  }
  const nullTest = asNode(node.NullTest);
  if (nullTest !== undefined) {
    const field = columnName(nullTest.arg);
    if (field === undefined) {
      return undefined;
    }
    const isNull =
      nullTest.nulltesttype === 'IS_NULL' ||
      nullTest.nulltesttype === 0 ||
      nullTest.nulltesttype === undefined;
    return { op: 'isNull', field, value: isNull };
  }
  const compound = boolOp(node);
  if (compound !== undefined) {
    const expr = asNode(node.BoolExpr);
    const args = expr?.args;
    if (!Array.isArray(args)) {
      return undefined;
    }
    if (compound === 'not') {
      const inner = mapNode(args[0], memberships, functions, unmapped, joins);
      return inner === undefined ? undefined : { op: 'not', condition: inner };
    }
    const children = args
      .map((arg) => mapNode(arg, memberships, functions, unmapped, joins))
      .filter((item): item is Condition => item !== undefined);
    if (children.length !== args.length) {
      return undefined;
    }
    return { op: compound, conditions: children };
  }
  const table = membershipTable(node);
  if (table !== undefined) {
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
    const call = asNode(node.FuncCall);
    const rawArgs = Array.isArray(call?.args) ? call.args : [];
    const args: SqlFunctionArg[] =
      mapping.args?.map((field) => ({ field })) ??
      rawArgs
        .map((arg) => argFromNode(arg))
        .filter((item): item is SqlFunctionArg => item !== undefined);
    return {
      op: 'sqlFunction',
      name,
      args,
      twin: mapping.twin as Condition,
    };
  }
  const op = operatorName(node);
  const expr = asNode(node.A_Expr);
  if (
    op === '=' ||
    op === '<>' ||
    op === '>' ||
    op === '>=' ||
    op === '<' ||
    op === '<='
  ) {
    const left = columnName(expr?.lexpr) ?? columnName(expr?.rexpr);
    const right = expr?.lexpr;
    const leftIsColumn = columnName(expr?.lexpr) !== undefined;
    const other = leftIsColumn ? expr?.rexpr : right;
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
  const expr = asNode(node?.A_Expr);
  if (expr === undefined) {
    return undefined;
  }
  const name = operatorName(node);
  if (name !== '->>' && name !== '->') {
    return undefined;
  }
  const leftName = funcName(expr.lexpr);
  if (leftName !== 'auth.jwt' && leftName !== 'auth.session') {
    const sub = asNode(unwrap(expr.lexpr));
    const nested = asNode(sub?.SubLink);
    if (nested !== undefined && !isAuthUid({ SubLink: nested })) {
      const select = asNode(asNode(nested.subselect)?.SelectStmt);
      const targets = select?.targetList;
      if (Array.isArray(targets) && targets[0] !== undefined) {
        const res = asNode(asNode(targets[0])?.ResTarget);
        const innerName = funcName(res?.val);
        if (innerName !== 'auth.jwt' && innerName !== 'auth.session') {
          return undefined;
        }
      }
    }
  }
  const claim = constValue(expr.rexpr);
  return typeof claim === 'string' ? claim : undefined;
}
