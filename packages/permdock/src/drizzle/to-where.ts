import { createRequire } from 'node:module';

import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { DrizzleOperators, DrizzleWhereOptions } from './types.ts';

import {
  type CompiledExists,
  type CompiledWhere,
  compileWhere,
} from '../conditions/compile.ts';
import { compact } from '../core/compact.ts';
import { assertSafeKey } from '../core/paths.ts';

function loadOperators(injected?: DrizzleOperators): DrizzleOperators {
  if (injected !== undefined) {
    return injected;
  }
  try {
    return createRequire(import.meta.url)('drizzle-orm') as DrizzleOperators;
  } catch {
    throw new Error('PermDock: permdock/drizzle requires the drizzle-orm peer');
  }
}

function ident(name: string): string {
  assertSafeKey(name, 'sql identifier');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return name;
}

function column(
  table: Record<string, unknown>,
  field: string,
  columns: Readonly<Record<string, unknown>> | undefined,
): unknown {
  assertSafeKey(field, 'condition field');
  const mapped = columns?.[field] ?? table[field];
  if (mapped === undefined) {
    throw new Error(`PermDock: unknown column '${field}'`);
  }
  return mapped;
}

function tagged(
  strings: readonly string[],
  values: readonly unknown[],
  ops: DrizzleOperators,
): unknown {
  const template = strings as unknown as TemplateStringsArray;
  Object.defineProperty(template, 'raw', { value: strings });
  return ops.sql(template, ...values);
}

function existsSql(
  node: CompiledExists,
  table: Record<string, unknown>,
  options: DrizzleWhereOptions,
  ops: DrizzleOperators,
): unknown {
  const row = column(table, node.rowField, options.columns);
  const expiry =
    node.expiresAt === undefined
      ? ''
      : ` and (m.${ident(node.expiresAt)} is null or m.${ident(node.expiresAt)} > now())`;
  const tenant =
    node.tenantColumn === undefined || node.tenantValue === undefined
      ? ''
      : ` and m.${ident(node.tenantColumn)} = `;
  const head = `exists (select 1 from ${ident(node.table)} m where m.${ident(node.rowColumn)} = `;
  const mid = ` and m.${ident(node.user)} = `;
  const roles = ` and m.${ident(node.role)} in (`;
  if (tenant === '') {
    return tagged(
      [head, mid, roles, `)${expiry}`],
      [row, node.userValue, node.roles],
      ops,
    );
  }
  return tagged(
    [head, mid, roles, `)${expiry}${tenant}`, ''],
    [row, node.userValue, node.roles, node.tenantValue],
    ops,
  );
}

function render(
  node: CompiledWhere,
  table: Record<string, unknown>,
  options: DrizzleWhereOptions,
  ops: DrizzleOperators,
): unknown {
  switch (node.kind) {
    case 'never':
      return ops.sql`false`;
    case 'always':
      return ops.sql`true`;
    case 'isNull': {
      const col = column(table, node.field, options.columns);
      return node.negated ? ops.isNotNull(col) : ops.isNull(col);
    }
    case 'and':
      return ops.and(
        ...node.items.map((item) => render(item, table, options, ops)),
      );
    case 'or':
      return ops.or(
        ...node.items.map((item) => render(item, table, options, ops)),
      );
    case 'not':
      return ops.not(render(node.item, table, options, ops));
    case 'exists':
      return existsSql(node, table, options, ops);
    case 'compare': {
      const col = column(table, node.field, options.columns);
      switch (node.op) {
        case 'eq':
          return ops.eq(col, node.value);
        case 'ne':
          return ops.ne(col, node.value);
        case 'gt':
          return ops.gt(col, node.value);
        case 'gte':
          return ops.gte(col, node.value);
        case 'lt':
          return ops.lt(col, node.value);
        case 'lte':
          return ops.lte(col, node.value);
        case 'in':
          return ops.inArray(col, node.value as readonly unknown[]);
        case 'notIn':
          return ops.notInArray(col, node.value as readonly unknown[]);
        case 'contains':
          return typeof node.value === 'string'
            ? ops.like(col, `%${node.value}%`)
            : tagged(['', ' @> ', ''], [col, node.value], ops);
        default: {
          const exhaustive: never = node.op;
          throw new Error(`PermDock: unknown compare '${String(exhaustive)}'`);
        }
      }
    }
    default: {
      const exhaustive: never = node;
      throw new Error(
        `PermDock: unknown compiled node '${String(exhaustive)}'`,
      );
    }
  }
}

export function toWhere(
  input: Condition | WhereResult,
  table: Record<string, unknown>,
  options: DrizzleWhereOptions = {},
): unknown {
  const compiled = compileWhere(
    input,
    compact({
      subject: options.subject,
      memberships: options.memberships,
      now: options.now,
    }),
  );
  return render(compiled, table, options, loadOperators(options.operators));
}
