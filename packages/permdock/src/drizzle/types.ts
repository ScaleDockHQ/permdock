import type { MembershipsMapping } from '../conditions/compile.ts';
import type { Subject } from '../core/subject.ts';

export type DrizzleWhereOptions = {
  readonly columns?: Readonly<Record<string, unknown>>;
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
  readonly operators?: DrizzleOperators;
};

export type DrizzleOperators = {
  readonly and: (...args: unknown[]) => unknown;
  readonly or: (...args: unknown[]) => unknown;
  readonly not: (value: unknown) => unknown;
  readonly eq: (column: unknown, value: unknown) => unknown;
  readonly ne: (column: unknown, value: unknown) => unknown;
  readonly gt: (column: unknown, value: unknown) => unknown;
  readonly gte: (column: unknown, value: unknown) => unknown;
  readonly lt: (column: unknown, value: unknown) => unknown;
  readonly lte: (column: unknown, value: unknown) => unknown;
  readonly inArray: (column: unknown, values: readonly unknown[]) => unknown;
  readonly notInArray: (column: unknown, values: readonly unknown[]) => unknown;
  readonly isNull: (column: unknown) => unknown;
  readonly isNotNull: (column: unknown) => unknown;
  readonly like: (column: unknown, value: unknown) => unknown;
  readonly sql: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => unknown;
};
