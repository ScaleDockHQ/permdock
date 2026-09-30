import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { Subject } from '../core/subject.ts';
import type {
  KyselyExpressionBuilder,
  KyselySql,
  KyselyWhereOptions,
  KyselyWithSubjectOptions,
} from './types.ts';

import {
  type CompiledExists,
  type CompiledSql,
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
import { type RowCheck, rowCheckFrom } from '../conditions/row-check.ts';
import {
  statementTemplate,
  subjectStatements,
} from '../conditions/subject-settings.ts';
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

function loadSql(injected?: KyselySql): KyselySql {
  if (injected !== undefined) {
    return injected;
  }
  // SAFETY: optional chaining guards a missing process; node:module is Node's createRequire module.
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
        ) => (id: string) => { readonly sql: KyselySql };
      }
    | undefined;
  try {
    if (loader === undefined) {
      throw new Error('no module loader');
    }
    return loader.createRequire(import.meta.url)('kysely').sql;
  } catch {
    throw new Error(
      'PermDock: graph grants and withSubject in permdock/kysely need the kysely peer; pass `sql` on runtimes without require',
    );
  }
}

function graphExpr(
  node: CompiledSql,
  table: string,
  options: KyselyWhereOptions,
): unknown {
  const sql = loadSql(options.sql);
  const strings: string[] = [''];
  const values: unknown[] = [];
  for (const part of node.parts) {
    if ('text' in part) {
      strings[strings.length - 1] += part.text;
      continue;
    }
    values.push(
      'column' in part
        ? sql.ref(col(table, part.column, options.columns))
        : 'subject' in part
          ? node.subject
          : part.value,
    );
    strings.push('');
  }
  // SAFETY: a string array becomes a TemplateStringsArray once raw is defined on the next line.
  const template = strings as unknown as TemplateStringsArray;
  Object.defineProperty(template, 'raw', { value: strings });
  return sql(template, ...values);
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
    case 'sql':
      return graphExpr(node, table, options);
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
      relations: options.relations,
    }),
  );
  return (eb) => render(eb, compiled, table, options);
}

type KyselyLike<Trx> = {
  transaction(): {
    execute<T>(fn: (trx: Trx) => Promise<T>): Promise<T>;
  };
};

type Executable = { execute(db: unknown): Promise<unknown> };

/**
 * Runs `fn` in a transaction whose role and claims are `permdock.subject`'s, so the generated
 * RLS policies decide for the same subject as the in-process checks.
 */
export function withSubject<Trx, T>(
  db: KyselyLike<Trx>,
  permdock: { readonly subject: Subject },
  fn: (trx: Trx) => Promise<T>,
  options: KyselyWithSubjectOptions = {},
): Promise<T> {
  const statements = subjectStatements(permdock, options);
  const sql = loadSql(options.sql);
  return db.transaction().execute(async (trx) => {
    for (const statement of statements) {
      // SAFETY: Kysely's sql tag returns a RawBuilder, which has execute(db).
      const query = sql(
        statementTemplate(statement),
        ...statement.values,
      ) as Executable;
      // oxlint-disable-next-line no-await-in-loop -- the role must be set before the claims
      await query.execute(trx);
    }
    return fn(trx);
  });
}

type KyselySelectable = {
  selectFrom(table: never): {
    select(selection: (eb: never) => unknown): {
      where(where: never): {
        limit(count: number): {
          execute(): Promise<readonly { readonly granted?: unknown }[]>;
        };
      };
    };
  };
};

/**
 * One query for one row: `{ found: false }` when `key` matches nothing, otherwise whether the
 * permission filter keeps the row. Throws when `key` matches more than one row.
 */
export async function checkRow(
  db: KyselySelectable,
  table: string,
  input: Condition | WhereResult,
  key: (eb: KyselyExpressionBuilder) => unknown,
  options: KyselyWhereOptions = {},
): Promise<RowCheck> {
  const sql = loadSql(options.sql);
  const filter = toWhere(input, table, options);
  // SAFETY: never-typed parameters accept any Kysely table or expression; sql returns a RawBuilder.
  const rows = await db
    .selectFrom(table as never)
    .select(((eb: KyselyExpressionBuilder) =>
      (
        sql`coalesce(${filter(eb)}, false)` as {
          as(alias: string): unknown;
        }
      ).as('granted')) as never)
    .where(key as never)
    .limit(2)
    .execute();
  return rowCheckFrom(rows);
}
