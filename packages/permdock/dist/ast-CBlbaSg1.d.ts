//#region src/conditions/ast.d.ts
type ConditionRef = {
  readonly ref: string;
};
type ConditionDate = {
  readonly date: string;
};
type ConditionValue = string | number | boolean | null | readonly ConditionValue[] | ConditionRef | ConditionDate;
type ComparisonOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
type ComparisonCondition = {
  readonly op: ComparisonOp;
  readonly field: string;
  readonly value: ConditionValue;
};
type InCondition = {
  readonly op: "in" | "notIn";
  readonly field: string;
  readonly value: readonly ConditionValue[] | ConditionRef;
};
type IsNullCondition = {
  readonly op: "isNull";
  readonly field: string;
  readonly value: boolean;
};
type AndCondition = {
  readonly op: "and";
  readonly conditions: readonly Condition[];
};
type OrCondition = {
  readonly op: "or";
  readonly conditions: readonly Condition[];
};
type NotCondition = {
  readonly op: "not";
  readonly condition: Condition;
};
type MemberOfCondition = {
  readonly op: "memberOf";
  readonly scope: "tenant" | "team" | "resource";
  readonly field: string;
  readonly roles: readonly string[];
  readonly resource?: string;
  readonly parents?: readonly string[];
};
type OpaqueCondition = {
  readonly op: "opaque";
  readonly sql: string;
  readonly fingerprint: string;
};
type Condition = ComparisonCondition | InCondition | IsNullCondition | AndCondition | OrCondition | NotCondition | MemberOfCondition | OpaqueCondition;
//#endregion
export { OpaqueCondition as a, MemberOfCondition as i, ConditionRef as n, ConditionValue as r, Condition as t };