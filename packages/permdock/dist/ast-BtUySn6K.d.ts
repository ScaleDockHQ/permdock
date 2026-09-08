//#region src/core/subject.d.ts
type JsonWebKeyLike = {
  readonly kty?: string;
  readonly [key: string]: unknown;
};
type Binding = {
  readonly jkt?: string;
  readonly "x5t#S256"?: string;
  readonly jwk?: JsonWebKeyLike;
  readonly kid?: string;
};
type Assurance = {
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly authTime?: number;
};
type Membership = {
  readonly tenant?: string;
  readonly team?: string;
  readonly on?: {
    readonly resource: string;
    readonly id: string;
  };
  readonly roles: readonly string[];
  readonly via?: string;
  readonly expiresAt?: number;
};
type CustomRole = {
  readonly tenant: string;
  readonly name: string;
  readonly includes: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
};
type Principal = {
  readonly id: string;
  readonly issuer?: string;
  readonly kind?: "user" | "service" | "workload";
  readonly roles?: readonly string[];
  readonly memberships?: readonly Membership[];
  readonly tenant?: string;
  readonly assurance?: Assurance;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};
type Actor = {
  readonly id: string;
  readonly kind: string;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};
type AuthorizationDetail = {
  readonly type: string;
  readonly actions?: readonly string[];
  readonly [key: string]: unknown;
};
type GnapAccess = string | Readonly<Record<string, unknown>>;
type Delegation = {
  readonly scopes?: readonly string[];
  readonly authorizationDetails?: readonly AuthorizationDetail[];
  readonly access?: readonly GnapAccess[];
  readonly chain?: unknown;
};
type Subject<TPrincipal extends Principal = Principal> = {
  readonly principal: TPrincipal | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};
//#endregion
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
export { OpaqueCondition as a, AuthorizationDetail as c, Delegation as d, GnapAccess as f, Subject as g, Principal as h, MemberOfCondition as i, Binding as l, Membership as m, ConditionRef as n, Actor as o, JsonWebKeyLike as p, ConditionValue as r, Assurance as s, Condition as t, CustomRole as u };