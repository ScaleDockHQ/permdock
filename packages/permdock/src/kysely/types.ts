import type { MembershipsMapping } from '../conditions/compile.ts';
import type { Subject } from '../core/subject.ts';

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

export type KyselyWhereOptions = {
  readonly columns?: Readonly<Record<string, string>>;
  /** Condition fields that are Postgres arrays; `contains` on them is `@>`. */
  readonly listFields?: readonly string[];
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
};

export type WithSubjectOptions = {
  readonly dialect?: 'supabase' | 'guc' | 'neon';
};
