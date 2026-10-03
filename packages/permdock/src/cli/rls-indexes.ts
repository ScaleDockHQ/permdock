import { createHash } from 'node:crypto';

import type { Condition } from '../conditions/ast.ts';
import type { RlsSqlContext } from './rls-sql.ts';

import {
  qualifiedTable,
  quoteIdent,
  quoteTable,
  scopeTable,
} from './rls-sql.ts';

/** An index a generated policy or helper needs, its first column the one it filters on. */
export type IndexTarget = {
  readonly table: string;
  readonly columns: readonly string[];
};

/** Postgres truncates identifiers longer than this, in bytes. */
const MAX_IDENT = 63;

/**
 * The row fields `condition` compares, through `and`, `or` and `not`. A
 * dotted field is a JSON path, which a plain index does not serve.
 */
export function conditionFields(condition: Condition | undefined): string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case 'and':
    case 'or':
      return condition.conditions.flatMap(conditionFields);
    case 'not':
      return conditionFields(condition.condition);
    case 'sqlFunction':
      return conditionFields(condition.twin);
    case 'opaque':
    case 'related':
      return [];
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
      return condition.field.includes('.') ? [] : [condition.field];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/**
 * Every index the generated SQL reads through: the row columns policies
 * filter on (scope keys and condition fields), and the membership tables'
 * user column, followed by the scope column the helpers select.
 */
export function indexTargets(
  ctx: RlsSqlContext,
  rowColumns: readonly { readonly table: string; readonly column: string }[],
): readonly IndexTarget[] {
  const targets = new Map<string, IndexTarget>();
  const add = (table: string, columns: readonly string[]): void => {
    const target = { table: qualifiedTable(table), columns };
    targets.set(`${target.table}\u0000${columns[0] ?? ''}`, target);
  };
  for (const { table, column } of rowColumns) {
    add(table, [column]);
  }
  for (const scope of ctx.scopes) {
    const mapped = scopeTable(ctx, scope.name);
    if (mapped !== undefined) {
      add(mapped.table.table, [mapped.table.user, mapped.column]);
    }
  }
  for (const source of [...(ctx.sources ?? []), ...(ctx.memberSources ?? [])]) {
    add(source.sql.table, [source.sql.user]);
  }
  return [...targets.values()].toSorted((a, b) =>
    `${a.table}.${a.columns.join(',')}` < `${b.table}.${b.columns.join(',')}`
      ? -1
      : 1,
  );
}

/** A stable index name under Postgres' identifier limit. */
export function indexName(target: IndexTarget): string {
  const bare = target.table.slice(target.table.lastIndexOf('.') + 1);
  const name = `permdock_${bare}_${target.columns.join('_')}_idx`;
  if (Buffer.byteLength(name) <= MAX_IDENT) {
    return name;
  }
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `permdock_${hash}_idx`;
}

/** `create index if not exists` for every target, one per line. */
export function indexesSql(targets: readonly IndexTarget[]): string {
  return targets
    .map(
      (target) =>
        `create index if not exists ${quoteIdent(indexName(target))} on ${quoteTable(target.table)} (${target.columns.map(quoteIdent).join(', ')});`,
    )
    .join('\n');
}
