import type { MembershipsMapping } from "../conditions/compile.ts";
import type { RelationsMapping } from "../conditions/graph-sql.ts";
import type { WithSubjectOptions } from "../conditions/subject-settings.ts";
import type { Subject } from "../core/subject.ts";

export type KyselySelectQuery = {
  select(expr: unknown): KyselySelectQuery;
  where(column: string, op: string, value: unknown): KyselySelectQuery;
  where(expression: unknown): KyselySelectQuery;
  whereRef(left: string, op: string, right: string): KyselySelectQuery;
};

export type KyselyExpressionBuilder = {
  (left: unknown, op: string, right: unknown): unknown;
  and(args: readonly unknown[]): unknown;
  or(args: readonly unknown[]): unknown;
  not(value: unknown): unknown;
  lit(value: unknown): unknown;
  val(value: unknown): unknown;
  ref(column: string): unknown;
  exists?(query: unknown): unknown;
  selectFrom?(table: string): KyselySelectQuery;
};

/** Kysely's `sql` tag; `import { sql } from 'kysely'`. */
export type KyselySql = {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown;
  ref(reference: string): unknown;
};

export type KyselyWhereOptions = {
  readonly columns?: Readonly<Record<string, string>>;
  /** Condition fields that are Postgres arrays; `contains` on them is `@>`. */
  readonly listFields?: readonly string[];
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  /** Where the relation graph lives; graph grants compile to Postgres subqueries with it and are refused without. */
  readonly relations?: RelationsMapping;
  readonly now?: number;
  /** Kysely's `sql` tag, for graph subqueries on runtimes without `require`; loaded from the `kysely` peer by default. */
  readonly sql?: KyselySql;
};

export type KyselyWithSubjectOptions = WithSubjectOptions & {
  /** Kysely's `sql` tag, on runtimes without `require`; loaded from the `kysely` peer by default. */
  readonly sql?: KyselySql;
};
