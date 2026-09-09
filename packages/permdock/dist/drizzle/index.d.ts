import { d as Subject } from "../subject-BcgWbogX.js";
import { t as Condition } from "../ast-CBlbaSg1.js";
import { a as WhereResult } from "../permdock-BFyP-l5_.js";
import { t as MembershipsMapping } from "../compile-CB05wDpn.js";
//#region src/drizzle/types.d.ts
type DrizzleWhereOptions = {
  readonly columns?: Readonly<Record<string, unknown>>;
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
  readonly operators?: DrizzleOperators;
};
type DrizzleOperators = {
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
  readonly sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
};
//#endregion
//#region src/drizzle/to-where.d.ts
export declare function toWhere(input: Condition | WhereResult, table: Record<string, unknown>, options?: DrizzleWhereOptions): unknown;
//#endregion
export type { DrizzleOperators, DrizzleWhereOptions, MembershipsMapping };