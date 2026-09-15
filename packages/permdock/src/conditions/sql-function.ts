import type { SqlFunctionArg, SqlFunctionCondition } from './ast.ts';

import { freezeDeep } from '../core/freeze.ts';
import { normalizeWhere } from './normalize.ts';
import {
  assertPortableTwin,
  assertSqlFunctionArg,
  assertSqlFunctionName,
} from './sql-function-assert.ts';

export function sqlFunction(
  name: string,
  options: {
    readonly args?: readonly SqlFunctionArg[];
    readonly twin: unknown;
  },
): SqlFunctionCondition {
  assertSqlFunctionName(name);
  const args = options.args ?? [];
  for (const arg of args) {
    assertSqlFunctionArg(arg);
  }
  const twin = normalizeWhere(options.twin);
  assertPortableTwin(twin);
  return freezeDeep({
    op: 'sqlFunction',
    name,
    args,
    twin,
  });
}
