export type ConditionRef = {
  readonly ref: string;
};

export type ConditionDate = {
  readonly date: string;
};

export type ConditionValue =
  | string
  | number
  | boolean
  | null
  | readonly ConditionValue[]
  | ConditionRef
  | ConditionDate;

export type ComparisonOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains';

export type ComparisonCondition = {
  readonly op: ComparisonOp;
  readonly field: string;
  readonly value: ConditionValue;
};

export type InCondition = {
  readonly op: 'in' | 'notIn';
  readonly field: string;
  readonly value: readonly ConditionValue[] | ConditionRef;
};

export type IsNullCondition = {
  readonly op: 'isNull';
  readonly field: string;
  readonly value: boolean;
};

export type AndCondition = {
  readonly op: 'and';
  readonly conditions: readonly Condition[];
};

export type OrCondition = {
  readonly op: 'or';
  readonly conditions: readonly Condition[];
};

export type NotCondition = {
  readonly op: 'not';
  readonly condition: Condition;
};

export type MemberOfCondition = {
  readonly op: 'memberOf';
  /** A declared scope name (or the `tenant` / `team` alias), or `'resource'`. */
  readonly scope: string;
  readonly field: string;
  readonly roles: readonly string[];
  readonly resource?: string;
  readonly parents?: readonly MemberOfParent[];
};

/**
 * A row field holding an ancestor's id. The keyed form matches only a
 * membership on that resource; a bare field name matches a membership on any
 * resource whose id equals the field.
 */
export type MemberOfParent =
  | string
  | { readonly field: string; readonly resource: string };

export function parentHop(parent: MemberOfParent): {
  readonly field: string;
  readonly resource?: string;
} {
  return typeof parent === 'string' ? { field: parent } : parent;
}

export type OpaqueCondition = {
  readonly op: 'opaque';
  readonly sql: string;
  readonly fingerprint: string;
};

export type SqlFunctionField = {
  readonly field: string;
};

export type SqlFunctionArg = ConditionValue | SqlFunctionField;

export type SqlFunctionCondition = {
  readonly op: 'sqlFunction';
  readonly name: string;
  readonly args: readonly SqlFunctionArg[];
  readonly twin: Condition;
};

export type Condition =
  | ComparisonCondition
  | InCondition
  | IsNullCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | MemberOfCondition
  | OpaqueCondition
  | SqlFunctionCondition;

export function isConditionRef(value: unknown): value is ConditionRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    'ref' in value &&
    typeof (value as ConditionRef).ref === 'string'
  );
}

export function isConditionDate(value: unknown): value is ConditionDate {
  return (
    value !== null &&
    typeof value === 'object' &&
    'date' in value &&
    typeof (value as ConditionDate).date === 'string' &&
    !('ref' in value)
  );
}

export function isCondition(value: unknown): value is Condition {
  return (
    value !== null &&
    typeof value === 'object' &&
    'op' in value &&
    typeof (value as { readonly op: unknown }).op === 'string'
  );
}

export function isSqlFunctionField(value: unknown): value is SqlFunctionField {
  return (
    value !== null &&
    typeof value === 'object' &&
    'field' in value &&
    typeof (value as SqlFunctionField).field === 'string' &&
    !('ref' in value) &&
    !('date' in value) &&
    !('op' in value)
  );
}

export function hasConditionOp(
  condition: Condition | undefined,
  op: Condition['op'],
): boolean {
  if (condition === undefined) {
    return false;
  }
  if (condition.op === op) {
    return true;
  }
  switch (condition.op) {
    case 'and':
    case 'or':
      return condition.conditions.some((child) => hasConditionOp(child, op));
    case 'not':
      return hasConditionOp(condition.condition, op);
    case 'sqlFunction':
      return hasConditionOp(condition.twin, op);
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
    case 'opaque':
      return false;
    default: {
      const exhaustive: never = condition;
      /* v8 ignore next */
      return exhaustive;
    }
  }
}
