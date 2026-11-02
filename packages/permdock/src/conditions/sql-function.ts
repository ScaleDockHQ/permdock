import type { SqlFunctionArg, SqlFunctionCondition } from "./ast.ts";

import { freezeDeep } from "../core/freeze.ts";
import { normalizeWhere } from "./normalize.ts";
import {
  assertPortableTwin,
  assertSqlFunctionArg,
  assertSqlFunctionName,
  assertSqlFunctionSet,
} from "./sql-function-assert.ts";

export function sqlFunction(
  name: string,
  options: {
    readonly args?: readonly SqlFunctionArg[];
    /**
     * The set form: the row's `column` must be one of the ids the function
     * returns. The function is called once per statement, without row-field
     * args, as `"column" in (select name(args))`.
     */
    readonly set?: { readonly column: string };
    readonly twin: unknown;
  },
): SqlFunctionCondition {
  assertSqlFunctionName(name);
  const args = options.args ?? [];
  for (const arg of args) {
    assertSqlFunctionArg(arg);
  }
  if (options.set !== undefined) {
    assertSqlFunctionSet(options.set);
  }
  const twin = normalizeWhere(options.twin);
  assertPortableTwin(twin);
  return freezeDeep({
    op: "sqlFunction",
    name,
    args,
    ...(options.set === undefined ? {} : { set: options.set }),
    twin,
  });
}
