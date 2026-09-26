import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { Subject } from '../core/subject.ts';

import {
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
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
};

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
  required: readonly string[],
): CompiledWhere {
  switch (node.kind) {
    case 'isNull':
      if (!required.includes(node.field)) {
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
        AND: node.items.map((item) => render(item, options)),
      };
    case 'or':
      return {
        OR: node.items.map((item) => render(item, options)),
      };
    case 'not':
      return { NOT: render(node.item, options) };
    // Unreachable: Prisma takes no `memberships` mapping, so `memberOf`
    // compiles from the subject. Fail closed if it ever arrives.
    case 'exists':
      return {
        [fieldName(node.rowField, options.fields)]: {
          in: [],
        },
      };
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
          return options.listFields?.includes(node.field) === true
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
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.OR) && record.OR.length === 0) {
    return true;
  }
  return Object.values(record).some((item) => containsEmptyOr(item));
}

function rewriteEmptyOr<T extends Record<string, unknown>>(args: T): T {
  const where = args.where;
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
  return render(
    foldRequired(compiled, options.requiredFields ?? []),
    options,
  ) as T;
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
  const wrap = ({
    args,
    query,
  }: {
    readonly args: Record<string, unknown>;
    readonly query: (next: Record<string, unknown>) => Promise<unknown>;
  }): Promise<unknown> => {
    return query(rewriteEmptyOr(args));
  };
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
