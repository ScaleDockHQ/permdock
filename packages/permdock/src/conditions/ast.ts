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
  readonly scope: 'tenant' | 'team' | 'resource';
  readonly field: string;
  readonly roles: readonly string[];
  readonly resource?: string;
  readonly parents?: readonly string[];
};

export type OpaqueCondition = {
  readonly op: 'opaque';
  readonly sql: string;
  readonly fingerprint: string;
};

export type Condition =
  | ComparisonCondition
  | InCondition
  | IsNullCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | MemberOfCondition
  | OpaqueCondition;

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
