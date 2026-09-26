import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { DrizzleOperators, DrizzleWhereOptions } from './types.ts';

import {
  type CompiledExists,
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
import { compact } from '../core/compact.ts';
import { assertSafeKey } from '../core/paths.ts';

function loadOperators(injected?: DrizzleOperators): DrizzleOperators {
  if (injected !== undefined) {
    return injected;
  }
  // Feature-detected so the entry loads on runtimes without a Node module
  // loader; there, pass `operators` (`import * as operators from 'drizzle-orm'`).
  const loader = (
    globalThis as {
      readonly process?: {
        readonly getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process?.getBuiltinModule?.('node:module') as
    | {
        readonly createRequire: (
          from: string,
        ) => (id: string) => DrizzleOperators;
      }
    | undefined;
  try {
    if (loader === undefined) {
      throw new Error('no module loader');
    }
    return loader.createRequire(import.meta.url)('drizzle-orm');
  } catch {
    throw new Error(
      'PermDock: permdock/drizzle requires the drizzle-orm peer; pass `operators` on runtimes without require',
    );
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
  table: object,
  field: string,
  columns: Readonly<Record<string, unknown>> | undefined,
): unknown {
  assertSafeKey(field, 'condition field');
  const mapped =
    columns?.[field] ?? (table as Readonly<Record<string, unknown>>)[field];
  if (mapped === undefined) {
    throw new Error(`PermDock: unknown column '${field}'`);
  }
  return mapped;
}

/** Drizzle's Postgres array columns (`text().array()`) report `dataType: 'array'`. */
function isArrayColumn(col: unknown): boolean {
  return (
    col !== null &&
    typeof col === 'object' &&
    (col as { readonly dataType?: unknown }).dataType === 'array'
  );
}

/** Literal SQL text interleaved with bound values, rendered through `sql`. */
type SqlPart = { readonly text: string } | { readonly value: unknown };

function tagged(parts: readonly SqlPart[], ops: DrizzleOperators): unknown {
  const strings: string[] = [''];
  const values: unknown[] = [];
  for (const part of parts) {
    if ('text' in part) {
      strings[strings.length - 1] += part.text;
    } else {
      values.push(part.value);
      strings.push('');
    }
  }
  const template = strings as unknown as TemplateStringsArray;
  Object.defineProperty(template, 'raw', { value: strings });
  return ops.sql(template, ...values);
}

function existsSql(
  node: CompiledExists,
  table: object,
  options: DrizzleWhereOptions,
  ops: DrizzleOperators,
): unknown {
  const m = (name: string): string => `m.${ident(name)}`;
  const parts: SqlPart[] = [
    {
      text: `exists (select 1 from ${ident(node.table)} m where ${m(node.rowColumn)} = `,
    },
    { value: column(table, node.rowField, options.columns) },
    { text: ` and ${m(node.user)} = ` },
    { value: node.userValue },
  ];
  if (node.roles.length > 0) {
    parts.push({ text: ` and ${m(node.role)} in (` });
    for (const [index, role] of node.roles.entries()) {
      if (index > 0) {
        parts.push({ text: ', ' });
      }
      parts.push({ value: role });
    }
    parts.push({ text: ')' });
  }
  if (node.expiresAt !== undefined) {
    const expires = m(node.expiresAt);
    parts.push(
      { text: ` and (${expires} is null or ${expires} > ` },
      { value: node.now },
      { text: ')' },
    );
  }
  if (node.tenantColumn !== undefined && node.tenantValue !== undefined) {
    const tenant = m(node.tenantColumn);
    parts.push(
      { text: ` and (${tenant} is null or ${tenant} = ` },
      { value: node.tenantValue },
      { text: ')' },
    );
  }
  if (node.resourceColumn !== undefined && node.resourceValue !== undefined) {
    parts.push(
      { text: ` and ${m(node.resourceColumn)} = ` },
      { value: node.resourceValue },
    );
  }
  parts.push({ text: ')' });
  return tagged(parts, ops);
}

function containsSql(
  col: unknown,
  value: unknown,
  ops: DrizzleOperators,
): unknown {
  if (isArrayColumn(col)) {
    return tagged(
      [{ value }, { text: ' = any(' }, { value: col }, { text: ')' }],
      ops,
    );
  }
  if (typeof value === 'string') {
    return ops.like(col, `%${escapeLike(value)}%`);
  }
  return tagged([{ value: col }, { text: ' @> ' }, { value }], ops);
}

function render(
  node: CompiledWhere,
  table: object,
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
          return containsSql(col, node.value, ops);
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
  table: object,
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
