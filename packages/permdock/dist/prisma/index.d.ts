import { d as Subject } from "../subject-BcgWbogX.js";
import { at as Condition } from "../policy-DdqgAkJT.js";
import { a as WhereResult } from "../permdock-CaK4qAlv.js";
import { t as MembershipsMapping } from "../compile-nbewGPVa.js";
//#region src/prisma/to-where.d.ts
type PrismaWhereOptions = {
  readonly fields?: Readonly<Record<string, string>>;
  readonly subject?: Subject;
  readonly memberships?: MembershipsMapping;
  readonly now?: number;
  readonly listFields?: readonly string[];
};
export declare function toWhere<T extends Record<string, unknown> = Record<string, unknown>>(input: Condition | WhereResult, options?: PrismaWhereOptions): T;
export declare function permdockExtension(): {
  readonly name: "permdock";
  readonly query: {
    readonly $allModels: Record<string, (args: {
      readonly args: Record<string, unknown>;
      readonly query: (next: Record<string, unknown>) => Promise<unknown>;
    }) => Promise<unknown>>;
  };
};
//#endregion
export type { MembershipsMapping, PrismaWhereOptions };