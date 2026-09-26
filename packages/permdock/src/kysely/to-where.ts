import type { Condition } from '../conditions/ast.ts';
import type { Snapshot } from '../core/interfaces.ts';
import type { WhereResult } from '../core/permdock.ts';
import type {
  KyselyExpressionBuilder,
  KyselyWhereOptions,
  WithSubjectOptions,
} from './types.ts';

import {
  type CompiledExists,
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
import { compact } from '../core/compact.ts';
import { assertSafeKey } from '../core/paths.ts';

function ident(name: string): string {
  assertSafeKey(name, 'sql identifier');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
  }
  return name;
}

function col(
  table: string,
  field: string,
  columns: Readonly<Record<string, string>> | undefined,
): string {
  assertSafeKey(field, 'condition field');
  return `${ident(table)}.${ident(columns?.[field] ?? field)}`;
}

function existsExpr(
  eb: KyselyExpressionBuilder,
  node: CompiledExists,
  table: string,
  options: KyselyWhereOptions,
): unknown {
  if (eb.exists === undefined || eb.selectFrom === undefined) {
    return eb.lit(false);
  }
  const m = (name: string): string => `m.${ident(name)}`;
  let query = eb
    .selectFrom(`${ident(node.table)} as m`)
    .select(eb.lit(1))
    .whereRef(
      m(node.rowColumn),
      '=',
      col(table, node.rowField, options.columns),
    )
    .where(m(node.user), '=', eb.val(node.userValue));
  if (node.roles.length > 0) {
    query = query.where(m(node.role), 'in', node.roles);
  }
  if (node.expiresAt !== undefined) {
    const expires = eb.ref(m(node.expiresAt));
    query = query.where(
      eb.or([eb(expires, 'is', null), eb(expires, '>', eb.val(node.now))]),
    );
  }
  if (node.tenantColumn !== undefined && node.tenantValue !== undefined) {
    const tenant = eb.ref(m(node.tenantColumn));
    query = query.where(
      eb.or([
        eb(tenant, 'is', null),
        eb(tenant, '=', eb.val(node.tenantValue)),
      ]),
    );
  }
  if (node.resourceColumn !== undefined && node.resourceValue !== undefined) {
    query = query.where(
      m(node.resourceColumn),
      '=',
      eb.val(node.resourceValue),
    );
  }
  return eb.exists(query);
}

function containsExpr(
  eb: KyselyExpressionBuilder,
  column: unknown,
  field: string,
  value: unknown,
  options: KyselyWhereOptions,
): unknown {
  if (options.listFields?.includes(field) === true) {
    return eb(column, '@>', eb.val([value]));
  }
  return typeof value === 'string'
    ? eb(column, 'like', eb.val(`%${escapeLike(value)}%`))
    : eb(column, '@>', eb.val(value));
}

function render(
  eb: KyselyExpressionBuilder,
  node: CompiledWhere,
  table: string,
  options: KyselyWhereOptions,
): unknown {
  switch (node.kind) {
    case 'never':
      return eb.lit(false);
    case 'always':
      return eb.lit(true);
    case 'isNull': {
      const column = eb.ref(col(table, node.field, options.columns));
      return node.negated ? eb(column, 'is not', null) : eb(column, 'is', null);
    }
    case 'and':
      return eb.and(node.items.map((item) => render(eb, item, table, options)));
    case 'or':
      return eb.or(node.items.map((item) => render(eb, item, table, options)));
    case 'not':
      return eb.not(render(eb, node.item, table, options));
    case 'exists':
      return existsExpr(eb, node, table, options);
    case 'compare': {
      const column = eb.ref(col(table, node.field, options.columns));
      switch (node.op) {
        case 'eq':
          return eb(column, '=', eb.val(node.value));
        case 'ne':
          return eb(column, '!=', eb.val(node.value));
        case 'gt':
          return eb(column, '>', eb.val(node.value));
        case 'gte':
          return eb(column, '>=', eb.val(node.value));
        case 'lt':
          return eb(column, '<', eb.val(node.value));
        case 'lte':
          return eb(column, '<=', eb.val(node.value));
        case 'in':
          return eb(column, 'in', node.value);
        case 'notIn':
          return eb(column, 'not in', node.value);
        case 'contains':
          return containsExpr(eb, column, node.field, node.value, options);
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
  table: string,
  options: KyselyWhereOptions = {},
): (eb: KyselyExpressionBuilder) => unknown {
  const compiled = compileWhere(
    input,
    compact({
      subject: options.subject,
      memberships: options.memberships,
      now: options.now,
    }),
  );
  return (eb) => render(eb, compiled, table, options);
}

type KyselyLike = {
  transaction(): {
    execute<T>(fn: (trx: unknown) => Promise<T>): Promise<T>;
  };
};

type SnapshotHolder = {
  snapshot(): Snapshot | string | Promise<Snapshot | string>;
};

export async function withSubject<T>(
  db: KyselyLike,
  permdock: SnapshotHolder,
  fn: (trx: unknown) => Promise<T>,
  options: WithSubjectOptions = {},
): Promise<T> {
  const snapshot = await permdock.snapshot();
  if (typeof snapshot === 'string') {
    throw new TypeError('PermDock: withSubject needs a JSON snapshot');
  }
  const userId = snapshot.subject.principal?.id ?? '';
  const tenant = snapshot.subject.principal?.tenant ?? '';
  return db.transaction().execute(async (trx) => {
    const exec = trx as {
      executeQuery?(query: {
        readonly sql: string;
        readonly parameters: readonly unknown[];
      }): Promise<unknown>;
    };
    const dialect = options.dialect ?? 'supabase';
    if (exec.executeQuery !== undefined) {
      if (dialect === 'guc' || dialect === 'neon') {
        await exec.executeQuery({
          sql: "select set_config('app.user_id', $1, true)",
          parameters: [userId],
        });
      } else {
        await exec.executeQuery({
          sql: "select set_config('request.jwt.claims', $1, true)",
          parameters: [JSON.stringify({ sub: userId, tenant })],
        });
      }
    }
    return fn(trx);
  });
}
