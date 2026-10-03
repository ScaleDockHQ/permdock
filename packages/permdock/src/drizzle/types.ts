import type { SQL, Table } from "drizzle-orm";

import type { MembershipsMapping } from "../conditions/compile.ts";
import type { RelationsMapping } from "../conditions/graph-sql.ts";
import type { WithSubjectOptions } from "../conditions/subject-settings.ts";
import type { Subject } from "../core/subject.ts";

/** A column of the Drizzle table `T` or an `SQL` expression; anything for a structural stand-in. */
export type DrizzleColumnOf<T> = T extends Table
  ? T["_"]["columns"][keyof T["_"]["columns"]] | SQL
  : unknown;

export type DrizzleWhereOptions<T = unknown> = {
  /** Condition field to column of the table passed to `toWhere`. */
  readonly columns?: Readonly<Record<string, DrizzleColumnOf<T>>>;
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  /** Where the relation graph lives; graph grants compile to Postgres subqueries with it and are refused without. */
  readonly relations?: RelationsMapping;
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

export type DrizzleWithSubjectOptions = WithSubjectOptions & {
  /** `import * as operators from 'drizzle-orm'`, on runtimes without `require`. */
  readonly operators?: DrizzleOperators;
};
