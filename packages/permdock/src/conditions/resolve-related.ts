import type { WhereResult } from '../core/permdock.ts';
import type { Condition, RelatedCondition } from './ast.ts';

import { PermDockValidationError } from '../core/errors.ts';
import { freezeDeep } from '../core/freeze.ts';
import {
  type RelationsMapping,
  relatedRowGuard,
  relatedTargetsSql,
  renderGraphSql,
} from './graph-sql.ts';

export type ResolveRelatedOptions = {
  /**
   * Runs one Postgres query with `$1`-style placeholders and returns its
   * rows; each row's `id` is an id the filtered field may hold. With Prisma:
   * `({ sql, values }) => prisma.$queryRawUnsafe(sql, ...values)`.
   */
  readonly run: (query: {
    readonly sql: string;
    readonly values: readonly unknown[];
  }) => Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** Where the relation graph lives. */
  readonly relations?: RelationsMapping;
  /** Turns an id (always text) into the field's type, e.g. `Number` for an integer key. */
  readonly parse?: (id: string, field: string) => unknown;
};

const NOTHING: Condition = { op: 'or', conditions: [] };

function notRestricted(column: string): Condition {
  return {
    op: 'or',
    conditions: [
      { op: 'eq', field: column, value: false },
      { op: 'isNull', field: column, value: true },
    ],
  };
}

function refused(detail: string): PermDockValidationError {
  return new PermDockValidationError({
    code: 'non-portable-condition',
    permission: '',
    resource: '',
    boundary: 'where',
    message: `PermDock: non-portable-condition: ${detail}`,
  });
}

/**
 * `where` with every `related` node replaced by the ids it reaches, read in
 * one query per node, so an ORM without raw subqueries (Prisma) filters the
 * graph with a plain `in`. The ids are read now: run the filtered query right
 * after, in the same transaction when the graph may change in between.
 */
export async function resolveRelated(
  where: WhereResult,
  options: ResolveRelatedOptions,
): Promise<WhereResult> {
  const resources = where.resources;
  const subject = where.subject?.principal?.id;

  async function resolveNode(node: RelatedCondition): Promise<Condition> {
    if (resources === undefined) {
      throw refused('related: the where() result carries no resource graph');
    }
    if (node.ids === undefined && (subject === undefined || subject === '')) {
      return NOTHING;
    }
    const query = renderGraphSql(
      relatedTargetsSql(node, { ...options.relations, resources }),
      {
        subject: subject ?? '',
        placeholder: (index) => `$${String(index)}`,
        /* v8 ignore next 3 */
        column: (name) => {
          throw refused(`related: no row column '${name}' in an id query`);
        },
      },
    );
    const rows = await options.run({
      sql: `select distinct r.id from (${query.sql}) r where r.id is not null`,
      values: query.values,
    });
    const ids = rows.flatMap((row) => {
      const id = row.id;
      if (typeof id !== 'string' && typeof id !== 'number') {
        return [];
      }
      const text = String(id);
      const parsed =
        options.parse === undefined ? text : options.parse(text, node.field);
      return typeof parsed === 'string' ||
        typeof parsed === 'number' ||
        typeof parsed === 'boolean'
        ? [parsed]
        : [];
    });
    const reach: Condition =
      ids.length === 0 ? NOTHING : { op: 'in', field: node.field, value: ids };
    const guard = relatedRowGuard(node);
    return guard === undefined || ids.length === 0
      ? reach
      : { op: 'and', conditions: [reach, notRestricted(guard)] };
  }

  async function resolve(node: Condition): Promise<Condition> {
    switch (node.op) {
      case 'related':
        return resolveNode(node);
      case 'and':
      case 'or':
        return {
          op: node.op,
          conditions: await Promise.all(node.conditions.map(resolve)),
        };
      case 'not':
        return { op: 'not', condition: await resolve(node.condition) };
      case 'sqlFunction':
        return { ...node, twin: await resolve(node.twin) };
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
        return node;
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  }

  const condition = await resolve(where.condition as Condition);
  const out = { condition, partial: where.partial };
  for (const key of ['subject', 'scopes', 'resources'] as const) {
    if (where[key] !== undefined) {
      Object.defineProperty(out, key, { value: where[key], enumerable: false });
    }
  }
  return freezeDeep(out) as WhereResult;
}
