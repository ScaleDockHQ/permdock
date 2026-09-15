import { assertSafeKey } from '../core/paths.ts';
import {
  type Condition,
  type SqlFunctionArg,
  isSqlFunctionField,
} from './ast.ts';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function assertSqlFunctionName(name: string): void {
  const parts = name.split('.');
  if (parts.length === 0 || parts.length > 2) {
    throw new Error(
      `PermDock: sqlFunction name '${name}' is not a SQL identifier`,
    );
  }
  for (const part of parts) {
    if (!IDENT.test(part)) {
      throw new Error(
        `PermDock: sqlFunction name '${name}' is not a SQL identifier`,
      );
    }
    assertSafeKey(part, 'sqlFunction name');
  }
}

export function assertSqlFunctionArg(arg: SqlFunctionArg): void {
  if (isSqlFunctionField(arg)) {
    assertSafeKey(arg.field, 'sqlFunction argument field');
  }
}

export function assertPortableTwin(condition: Condition, depth = 0): void {
  /* v8 ignore next 3 */
  if (depth > 32) {
    throw new Error('PermDock: sqlFunction twin is nested too deeply');
  }
  switch (condition.op) {
    case 'opaque':
      throw new Error('PermDock: sqlFunction twin must not be opaque');
    case 'sqlFunction':
      throw new Error('PermDock: sqlFunction twin must not nest sqlFunction');
    case 'and':
    case 'or':
      for (const child of condition.conditions) {
        assertPortableTwin(child, depth + 1);
      }
      break;
    case 'not':
      assertPortableTwin(condition.condition, depth + 1);
      break;
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
    case 'in':
    case 'notIn':
    case 'isNull':
    case 'memberOf':
      break;
    default: {
      const exhaustive: never = condition;
      /* v8 ignore next */
      void exhaustive;
    }
  }
}
