import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { Subject } from '../core/subject.ts';
import type { PrismaModelFields } from './model-fields.ts';

import {
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
import { type RowCheck, rowCheckOf } from '../conditions/row-check.ts';
import {
  statementText,
  subjectStatements,
  type WithSubjectOptions,
} from '../conditions/subject-settings.ts';
import { compact } from '../core/compact.ts';
import { assertSafeKey } from '../core/paths.ts';

export type PrismaWhereOptions = {
  readonly fields?: Readonly<Record<string, string>>;
  readonly subject?: Subject;
  readonly now?: number;
  readonly listFields?: readonly string[];
  // Prisma rejects a null filter on a required field, and its runtime data
  // model does not say which fields are required.
  readonly requiredFields?: readonly string[];
  /** Required and list fields read from the schema by `prismaModelFields`; adds to `requiredFields` and `listFields`. */
  readonly model?: PrismaModelFields;
};

type FieldTests = {
  readonly required: (field: string) => boolean;
  readonly list: (field: string) => boolean;
};

function fieldTests(
  options: Pick<
    PrismaWhereOptions,
    'fields' | 'listFields' | 'requiredFields' | 'model'
  >,
): FieldTests {
  const mapped = (field: string): string => fieldName(field, options.fields);
  return {
    required: (field) =>
      options.requiredFields?.includes(field) === true ||
      options.model?.required.includes(mapped(field)) === true,
    list: (field) =>
      options.listFields?.includes(field) === true ||
      options.model?.lists.includes(mapped(field)) === true,
  };
}

const EMPTY_OR: { readonly OR: readonly [] } = { OR: [] };

function fieldName(
  field: string,
  fields: Readonly<Record<string, string>> | undefined,
): string {
  assertSafeKey(field, 'condition field');
  return fields?.[field] ?? field;
}

const NEVER: CompiledWhere = { kind: 'never' };
const ALWAYS: CompiledWhere = { kind: 'always' };

function foldRequired(
  node: CompiledWhere,
  required: (field: string) => boolean,
): CompiledWhere {
  switch (node.kind) {
    case 'isNull':
      if (!required(node.field)) {
        return node;
      }
      return node.negated ? ALWAYS : NEVER;
    case 'and': {
      const items = node.items
        .map((item) => foldRequired(item, required))
        .filter((item) => item.kind !== 'always');
      if (items.some((item) => item.kind === 'never')) {
        return NEVER;
      }
      // SAFETY: items[0] is read only when items.length is 1.
      return items.length === 0
        ? ALWAYS
        : items.length === 1
          ? (items[0] as CompiledWhere)
          : { kind: 'and', items };
    }
    case 'or': {
      const items = node.items
        .map((item) => foldRequired(item, required))
        .filter((item) => item.kind !== 'never');
      if (items.some((item) => item.kind === 'always')) {
        return ALWAYS;
      }
      // SAFETY: items[0] is read only when items.length is 1.
      return items.length === 0
        ? NEVER
        : items.length === 1
          ? (items[0] as CompiledWhere)
          : { kind: 'or', items };
    }
    case 'not': {
      const item = foldRequired(node.item, required);
      return item.kind === 'never'
        ? ALWAYS
        : item.kind === 'always'
          ? NEVER
          : { kind: 'not', item };
    }
    case 'never':
    case 'always':
    case 'exists':
    case 'compare':
    case 'sql':
      return node;
    default: {
      const exhaustive: never = node;
      throw new Error(
        `PermDock: unknown compiled node '${String(exhaustive)}'`,
      );
    }
  }
}

function render(
  node: CompiledWhere,
  options: PrismaWhereOptions,
  tests: FieldTests,
): Record<string, unknown> {
  switch (node.kind) {
    case 'never':
      return { ...EMPTY_OR };
    case 'always':
      return {};
    case 'isNull': {
      const name = fieldName(node.field, options.fields);
      return node.negated
        ? { [name]: { not: null } }
        : { [name]: { equals: null } };
    }
    case 'and':
      return {
        AND: node.items.map((item) => render(item, options, tests)),
      };
    case 'or':
      return {
        OR: node.items.map((item) => render(item, options, tests)),
      };
    case 'not':
      return { NOT: render(node.item, options, tests) };
    // Unreachable: Prisma takes no `memberships` mapping, so `memberOf`
    // compiles from the subject. Fail closed if it ever arrives.
    case 'exists':
      return {
        [fieldName(node.rowField, options.fields)]: {
          in: [],
        },
      };
    // Unreachable: Prisma takes no `relations` mapping, so `related` is
    // refused unless `resolveRelated` turned it into ids first.
    case 'sql':
      return { ...EMPTY_OR };
    case 'compare': {
      const name = fieldName(node.field, options.fields);
      switch (node.op) {
        case 'eq':
          return { [name]: { equals: node.value } };
        case 'ne':
          return { [name]: { not: node.value } };
        case 'gt':
          return { [name]: { gt: node.value } };
        case 'gte':
          return { [name]: { gte: node.value } };
        case 'lt':
          return { [name]: { lt: node.value } };
        case 'lte':
          return { [name]: { lte: node.value } };
        case 'in':
          return { [name]: { in: node.value } };
        case 'notIn':
          return { [name]: { notIn: node.value } };
        case 'contains':
          return tests.list(node.field)
            ? { [name]: { has: node.value } }
            : {
                [name]: {
                  contains:
                    typeof node.value === 'string'
                      ? escapeLike(node.value)
                      : node.value,
                },
              };
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

function containsEmptyOr(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsEmptyOr(item));
  }
  // SAFETY: null, primitives and arrays returned above, so value is a non-array object here.
  const record = value as Record<string, unknown>;
  if (Array.isArray(record['OR']) && record['OR'].length === 0) {
    return true;
  }
  return Object.values(record).some((item) => containsEmptyOr(item));
}

function rewriteEmptyOr<T extends Record<string, unknown>>(args: T): T {
  const where = args['where'];
  if (where === undefined || !containsEmptyOr(where)) {
    return args;
  }
  return {
    ...args,
    where: { AND: [where, EMPTY_OR], OR: [] },
  };
}

export function toWhere<
  T extends Record<string, unknown> = Record<string, unknown>,
>(input: Condition | WhereResult, options: PrismaWhereOptions = {}): T {
  const compiled = compileWhere(
    input,
    compact({
      subject: options.subject,
      now: options.now,
    }),
  );
  const tests = fieldTests(options);
  // SAFETY: T names the caller's Prisma where input, the shape render emits.
  return render(foldRequired(compiled, tests.required), options, tests) as T;
}

function wrap({
  args,
  query,
}: {
  readonly args: Record<string, unknown>;
  readonly query: (next: Record<string, unknown>) => Promise<unknown>;
}): Promise<unknown> {
  return query(rewriteEmptyOr(args));
}

export function permdockExtension(): {
  readonly name: 'permdock';
  readonly query: {
    readonly $allModels: Record<
      string,
      (args: {
        readonly args: Record<string, unknown>;
        readonly query: (next: Record<string, unknown>) => Promise<unknown>;
      }) => Promise<unknown>
    >;
  };
} {
  return {
    name: 'permdock',
    query: {
      $allModels: {
        findMany: wrap,
        findFirst: wrap,
        count: wrap,
        aggregate: wrap,
        updateMany: wrap,
        deleteMany: wrap,
      },
    },
  };
}

type PrismaTransactionClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

type PrismaLike<Tx> = {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/**
 * Runs `fn` in an interactive transaction whose role and claims are `permdock.subject`'s, so
 * the generated RLS policies decide for the same subject as the in-process checks.
 */
export function withSubject<Tx extends PrismaTransactionClient, T>(
  prisma: PrismaLike<Tx>,
  permdock: { readonly subject: Subject },
  fn: (tx: Tx) => Promise<T>,
  options: WithSubjectOptions = {},
): Promise<T> {
  const statements = subjectStatements(permdock, options);
  return prisma.$transaction(async (tx) => {
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- the role must be set before the claims
      await tx.$executeRawUnsafe(statementText(statement), ...statement.values);
    }
    return fn(tx);
  });
}

type PrismaDelegate = {
  findFirst(args: {
    readonly where: Record<string, unknown>;
  }): Promise<unknown>;
};

/**
 * Checks one row by its unique key, for `findUnique`, `update` and `delete`, which take no
 * filter: `{ found: false }` when `unique` matches nothing, otherwise whether the permission
 * filter keeps the row. One query when granted, two otherwise.
 */
export async function checkRow(
  delegate: PrismaDelegate,
  input: Condition | WhereResult,
  unique: Record<string, unknown>,
  options: PrismaWhereOptions = {},
): Promise<RowCheck> {
  const filter = toWhere(input, options);
  const kept = await delegate.findFirst(
    rewriteEmptyOr({ where: { AND: [unique, filter] } }),
  );
  if (kept !== null && kept !== undefined) {
    return rowCheckOf(true, true);
  }
  const row = await delegate.findFirst({ where: unique });
  return rowCheckOf(row !== null && row !== undefined, false);
}
