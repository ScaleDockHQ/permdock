import { g as Subject, t as Condition } from "../ast-BtUySn6K.js";
import { f as SnapshotV2 } from "../interfaces-BuUjSMjB.js";
import { a as WhereResult } from "../permdock-CKANy_yd.js";
import { t as MembershipsMapping } from "../compile-DrkQKdIk.js";
//#region src/kysely/types.d.ts
type KyselySelectQuery = {
  select(expr: unknown): KyselySelectQuery;
  where(column: string, op: string, value: unknown): KyselySelectQuery;
  whereRef(left: string, op: string, right: string): KyselySelectQuery;
};
type KyselyExpressionBuilder = {
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
type KyselyWhereOptions = {
  readonly columns?: Readonly<Record<string, string>>;
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
};
type WithSubjectOptions = {
  readonly dialect?: "supabase" | "guc" | "neon";
};
//#endregion
//#region src/kysely/to-where.d.ts
export declare function toWhere(input: Condition | WhereResult, table: string, options?: KyselyWhereOptions): (eb: KyselyExpressionBuilder) => unknown;
type KyselyLike = {
  transaction(): {
    execute<T>(fn: (trx: unknown) => Promise<T>): Promise<T>;
  };
};
type SnapshotHolder = {
  snapshot(): SnapshotV2 | string | Promise<SnapshotV2 | string>;
};
export declare function withSubject<T>(db: KyselyLike, permdock: SnapshotHolder, fn: (trx: unknown) => Promise<T>, options?: WithSubjectOptions): Promise<T>;
//#endregion
export type { KyselyExpressionBuilder, KyselyWhereOptions, MembershipsMapping, WithSubjectOptions };