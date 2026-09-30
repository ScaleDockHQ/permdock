import type { Condition } from '../conditions/ast.ts';
import type { WhereResult } from '../core/permdock.ts';
import type { Subject } from '../core/subject.ts';
import type { PrismaModelFields } from './model-fields.ts';

import {
  type CompiledWhere,
  compileWhere,
  escapeLike,
} from '../conditions/compile.ts';
import { compact } from '../core/compact.ts';
import { PermDockValidationError } from '../core/errors.ts';
import { assertSafeKey } from '../core/paths.ts';

/** A Prisma 8 ORM field proxy: `u.email` inside `.where((u) => ...)`. */
export type PrismaFieldProxy = {
  eq(value: unknown): unknown;
  neq(value: unknown): unknown;
  gt(value: unknown): unknown;
  gte(value: unknown): unknown;
  lt(value: unknown): unknown;
  lte(value: unknown): unknown;
  like(pattern: string): unknown;
  in(values: readonly unknown[]): unknown;
  isNull(): unknown;
  isNotNull(): unknown;
};

/** `import { and, or, not } from '@prisma/orm-postgres/orm-client'`. */
export type PrismaCombinators = {
  readonly and: (...predicates: unknown[]) => unknown;
  readonly or: (...predicates: unknown[]) => unknown;
  readonly not: (predicate: unknown) => unknown;
};

export type PrismaPredicateOptions = {
  readonly fields?: Readonly<Record<string, string>>;
  readonly subject?: Subject;
  readonly now?: number;
  /** Required and list fields from `prismaModelFields`; `contains` on a list field is refused. */
  readonly model?: PrismaModelFields;
  readonly listFields?: readonly string[];
  /** A non-null column (the primary key) that spells constant true and false. Default `id`. */
  readonly key?: string;
  /** Loaded from `@prisma/orm-postgres/orm-client` by default. */
  readonly combinators?: PrismaCombinators;
};

function loadCombinators(injected?: PrismaCombinators): PrismaCombinators {
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
        ) => (id: string) => PrismaCombinators;
      }
    | undefined;
  try {
    if (loader === undefined) {
      throw new Error('no module loader');
    }
    return loader.createRequire(import.meta.url)(
      '@prisma/orm-postgres/orm-client',
    );
  } catch {
    throw new Error(
      'PermDock: toPredicate needs @prisma/orm-postgres; pass `combinators` on runtimes without require',
    );
  }
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

type Model = Readonly<Record<string, PrismaFieldProxy>>;

function render(
  node: CompiledWhere,
  model: Model,
  options: PrismaPredicateOptions,
  ops: PrismaCombinators,
): unknown {
  const proxy = (field: string): PrismaFieldProxy => {
    assertSafeKey(field, 'condition field');
    const name = options.fields?.[field] ?? field;
    assertSafeKey(name, 'Prisma field');
    const value = model[name];
    if (value === undefined) {
      throw refused(`no field '${name}' on the Prisma model`);
    }
    return value;
  };
  const key = (): PrismaFieldProxy => proxy(options.key ?? 'id');
  switch (node.kind) {
    case 'never':
      return key().isNull();
    case 'always':
      return key().isNotNull();
    case 'isNull':
      return node.negated
        ? proxy(node.field).isNotNull()
        : proxy(node.field).isNull();
    case 'and':
      return ops.and(
        ...node.items.map((item) => render(item, model, options, ops)),
      );
    case 'or':
      return ops.or(
        ...node.items.map((item) => render(item, model, options, ops)),
      );
    case 'not':
      return ops.not(render(node.item, model, options, ops));
    case 'exists':
      throw refused('memberOf with a memberships table');
    case 'sql':
      throw refused('relationship grant; resolve it first with resolveRelated');
    case 'compare': {
      const field = proxy(node.field);
      switch (node.op) {
        case 'eq':
          return field.eq(node.value);
        case 'ne':
          return field.neq(node.value);
        case 'gt':
          return field.gt(node.value);
        case 'gte':
          return field.gte(node.value);
        case 'lt':
          return field.lt(node.value);
        case 'lte':
          return field.lte(node.value);
        case 'in': {
          // SAFETY: compileWhere emits in and notIn compares only with an array value.
          const values = node.value as readonly unknown[];
          return values.length === 0 ? key().isNull() : field.in(values);
        }
        case 'notIn': {
          // SAFETY: compileWhere emits in and notIn compares only with an array value.
          const values = node.value as readonly unknown[];
          return values.length === 0
            ? key().isNotNull()
            : ops.not(field.in(values));
        }
        case 'contains': {
          const name = options.fields?.[node.field] ?? node.field;
          if (
            options.listFields?.includes(node.field) === true ||
            options.model?.lists.includes(name) === true
          ) {
            throw refused(`contains on the list field '${name}'`);
          }
          if (typeof node.value !== 'string') {
            throw refused(`contains with a non-string value on '${name}'`);
          }
          return field.like(`%${escapeLike(node.value)}%`);
        }
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

/**
 * Compiles a condition into a Prisma 8 ORM predicate: pass the result to
 * `db.orm.<ns>.<Model>.where(...)`. No grant compiles to a predicate that matches no row.
 */
export function toPredicate<M = Model>(
  input: Condition | WhereResult,
  options: PrismaPredicateOptions = {},
): (model: M) => unknown {
  const compiled = compileWhere(
    input,
    compact({ subject: options.subject, now: options.now }),
  );
  const ops = loadCombinators(options.combinators);
  // SAFETY: Prisma passes its model of field proxies; render refuses a field the model lacks.
  return (model) => render(compiled, model as Model, options, ops);
}
