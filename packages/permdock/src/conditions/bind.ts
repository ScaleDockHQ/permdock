import type { Subject } from '../core/subject.ts';

import {
  type Condition,
  type ConditionValue,
  type SqlFunctionArg,
  isConditionRef,
} from './ast.ts';
import { resolveConditionRef } from './refs.ts';

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

type RefFilter = (ref: string) => boolean;

function bindValue(
  value: ConditionValue,
  subject: Subject,
  only?: RefFilter,
): ConditionValue {
  if (isConditionRef(value) && only !== undefined && !only(value.ref)) {
    return value;
  }
  if (isConditionRef(value)) {
    const resolved = resolveConditionRef(value.ref, subject);
    if (Array.isArray(resolved)) {
      return resolved.filter((item) => isPrimitive(item));
    }
    return isPrimitive(resolved) ? resolved : null;
  }
  if (Array.isArray(value)) {
    return value.map((item: ConditionValue) => bindValue(item, subject, only));
  }
  return value;
}

function bindArg(
  arg: SqlFunctionArg,
  subject: Subject,
  only?: RefFilter,
): SqlFunctionArg {
  return arg !== null &&
    typeof arg === 'object' &&
    'field' in arg &&
    !isConditionRef(arg)
    ? arg
    : bindValue(arg as ConditionValue, subject, only);
}

/**
 * Replaces every `principal.*` / `context.*` ref with the subject's value, so
 * a `where()` result compiles the same without the subject. A ref the subject
 * does not hold binds to `null` (or `[]` in a list), which never matches, as
 * in `evaluateCondition`. With `only`, refs it rejects stay refs.
 */
export function bindConditionRefs(
  condition: Condition,
  subject: Subject,
  only?: RefFilter,
): Condition {
  switch (condition.op) {
    case 'and':
    case 'or':
      return {
        op: condition.op,
        conditions: condition.conditions.map((child) =>
          bindConditionRefs(child, subject, only),
        ),
      };
    case 'not':
      return {
        op: 'not',
        condition: bindConditionRefs(condition.condition, subject, only),
      };
    case 'in':
    case 'notIn': {
      const value = condition.value as ConditionValue;
      if (isConditionRef(value) && only !== undefined && !only(value.ref)) {
        return condition;
      }
      const bound = bindValue(value, subject, only);
      return {
        ...condition,
        value: Array.isArray(bound) ? bound : [],
      };
    }
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'contains':
      return {
        ...condition,
        value: bindValue(condition.value, subject, only),
      };
    case 'sqlFunction':
      return {
        ...condition,
        args: condition.args.map((arg) => bindArg(arg, subject, only)),
        twin: bindConditionRefs(condition.twin, subject, only),
      };
    case 'isNull':
    case 'memberOf':
    case 'related':
    case 'opaque':
      return condition;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}
