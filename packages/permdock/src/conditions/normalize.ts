import { freezeDeep } from '../core/freeze.ts';
import { assertSafeKey, ownKeys } from '../core/paths.ts';
import {
  type Condition,
  type ConditionValue,
  isCondition,
  isConditionDate,
  isConditionRef,
} from './ast.ts';
import { opaque } from './opaque.ts';
import { isSubjectRef } from './refs.ts';

const FIELD_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'notIn',
  'isNull',
]);

export type FieldOperator = {
  readonly eq?: unknown;
  readonly ne?: unknown;
  readonly gt?: unknown;
  readonly gte?: unknown;
  readonly lt?: unknown;
  readonly lte?: unknown;
  readonly contains?: unknown;
  readonly in?: unknown;
  readonly notIn?: unknown;
  readonly isNull?: boolean;
};

export type WhereShorthand<T = Record<string, unknown>> = {
  readonly and?: readonly WhereShorthand<T>[];
  readonly or?: readonly WhereShorthand<T>[];
  readonly not?: WhereShorthand<T>;
} & {
  readonly [K in keyof T]?: T[K] | FieldOperator | { readonly ref: string };
};

function toValue(raw: unknown): ConditionValue {
  if (isSubjectRef(raw) || isConditionRef(raw)) {
    return freezeDeep({ ref: raw.ref });
  }
  if (raw instanceof Date) {
    return freezeDeep({ date: raw.toISOString() });
  }
  if (isConditionDate(raw)) {
    return freezeDeep({ date: raw.date });
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => toValue(item));
  }
  if (
    raw === null ||
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
  ) {
    return raw;
  }
  throw new Error('PermDock: unsupported condition value');
}

function flatten(
  op: 'and' | 'or',
  conditions: readonly Condition[],
): readonly Condition[] {
  const out: Condition[] = [];
  for (const condition of conditions) {
    if (condition.op === op) {
      out.push(...condition.conditions);
    } else {
      out.push(condition);
    }
  }
  return out;
}

function collapse(condition: Condition): Condition {
  if (condition.op === 'and' || condition.op === 'or') {
    const flat = flatten(condition.op, condition.conditions).map(collapse);
    if (flat.length === 0) {
      throw new Error(`PermDock: empty ${condition.op} condition`);
    }
    if (flat.length === 1) {
      return flat[0]!;
    }
    return freezeDeep({ op: condition.op, conditions: flat });
  }
  if (condition.op === 'not') {
    return freezeDeep({ op: 'not', condition: collapse(condition.condition) });
  }
  return freezeDeep(condition);
}

function fieldCondition(field: string, raw: unknown): Condition {
  assertSafeKey(field, 'condition field');
  if (isCondition(raw) && raw.op === 'opaque') {
    return raw;
  }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !isSubjectRef(raw) &&
    !isConditionRef(raw) &&
    !isConditionDate(raw) &&
    !Array.isArray(raw) &&
    !(raw instanceof Date)
  ) {
    const keys = ownKeys(raw);
    if (keys.length === 1 && keys[0] !== undefined && FIELD_OPS.has(keys[0])) {
      const op = keys[0];
      const value = (raw as Record<string, unknown>)[op];
      if (op === 'isNull') {
        if (typeof value !== 'boolean') {
          throw new TypeError('PermDock: isNull requires a boolean');
        }
        return collapse({ op: 'isNull', field, value });
      }
      if (op === 'in' || op === 'notIn') {
        if (isSubjectRef(value) || isConditionRef(value)) {
          return collapse({ op, field, value: { ref: value.ref } });
        }
        if (!Array.isArray(value)) {
          throw new TypeError(
            `PermDock: ${op} requires an array or subject reference`,
          );
        }
        return collapse({
          op,
          field,
          value: value.map((item) => toValue(item)),
        });
      }
      return collapse({
        op: op as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains',
        field,
        value: toValue(value),
      });
    }
  }
  return collapse({ op: 'eq', field, value: toValue(raw) });
}

export function normalizeWhere(input: unknown): Condition {
  if (isCondition(input)) {
    return collapse(input);
  }
  if (
    input !== null &&
    typeof input === 'object' &&
    'sql' in input &&
    'fingerprint' in input &&
    typeof (input as { readonly sql: unknown }).sql === 'string'
  ) {
    return opaque({
      sql: (input as { readonly sql: string; readonly fingerprint: string })
        .sql,
      fingerprint: (input as { readonly fingerprint: string }).fingerprint,
    });
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('PermDock: condition must be an object');
  }
  const parts: Condition[] = [];
  for (const key of Object.keys(input)) {
    const value = (input as Record<string, unknown>)[key];
    if (key === 'and') {
      if (!Array.isArray(value)) {
        throw new TypeError('PermDock: and requires an array');
      }
      parts.push(
        collapse({ op: 'and', conditions: value.map(normalizeWhere) }),
      );
      continue;
    }
    if (key === 'or') {
      if (!Array.isArray(value)) {
        throw new TypeError('PermDock: or requires an array');
      }
      parts.push(collapse({ op: 'or', conditions: value.map(normalizeWhere) }));
      continue;
    }
    if (key === 'not') {
      parts.push(collapse({ op: 'not', condition: normalizeWhere(value) }));
      continue;
    }
    parts.push(fieldCondition(key, value));
  }
  if (parts.length === 0) {
    throw new Error('PermDock: empty condition');
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return collapse({ op: 'and', conditions: parts });
}
