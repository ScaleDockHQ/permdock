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
//#region src/core/interfaces.d.ts
type RoleSource = {
  rolesFor(tenant: string): CustomRole[] | Promise<CustomRole[]>;
  assignable?(tenant: string): string[] | Promise<string[]>;
};
type MembershipSource = {
  membershipsFor(principal: {
    readonly id: string;
    readonly kind?: string;
  }, options: {
    readonly tenant?: string;
  }): Membership[] | Promise<Membership[]>;
};
type JwtClaims = {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [key: string]: unknown;
};
type TokenFailureCause = "invalid-signature" | "expired" | "not-yet-valid" | "wrong-audience" | "wrong-issuer" | "wrong-token-type" | "alg-not-allowed" | "alg-none" | "unknown-kid" | "malformed" | "encrypted-token" | "dpop-proof-invalid" | "mtls-binding-mismatch" | "sender-constraint-required" | "token-in-query" | "invalid-claims" | "jwks-unavailable" | "discovery-unavailable" | "discovery-mismatch";
type VerifiedToken<TClaims extends JwtClaims = JwtClaims> = {
  readonly ok: true;
  readonly claims: TClaims;
  readonly header: {
    readonly alg: string;
    readonly kid?: string;
    readonly typ?: string;
  };
};
type VerificationFailure = {
  readonly ok: false;
  readonly reason: "invalid-token";
  readonly cause: TokenFailureCause;
};
type TokenVerifier<TClaims extends JwtClaims = JwtClaims> = {
  verify(token: string, expectations: {
    readonly typ?: string | readonly string[];
    readonly audience?: string | readonly string[];
    readonly issuer?: string;
    readonly clockTolerance?: number;
  }): Promise<VerifiedToken<TClaims> | VerificationFailure>;
};
type TokenSigner = {
  sign(payload: Readonly<Record<string, unknown>>, options: {
    readonly typ: "permdock-snapshot+jwt" | "permdock-approval+jwt" | "permdock-decisions+jwt";
    readonly audience?: string | readonly string[];
    readonly expiresAt?: number;
  }): Promise<string>;
  readonly kid?: string;
  jwks?(): Promise<{
    readonly keys: readonly JsonWebKeyLike[];
  }>;
};
type SubjectResolver<TInput, TPrincipal extends Principal = Principal> = (input: TInput, options?: {
  readonly tenant?: string;
}) => Subject<TPrincipal> | Promise<Subject<TPrincipal>>;
type SnapshotV2 = {
  readonly v: 1 | 2;
  readonly issuedAt: number;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
      readonly memberships?: readonly Membership[];
    } | null;
    readonly delegation?: Subject["delegation"];
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly roles: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly tenants: readonly string[];
  readonly include?: readonly string[];
  readonly simulated?: true;
  readonly expiresAt?: number;
};
type SnapshotGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human";
  readonly scope?: "tenant" | "team" | {
    readonly resource: string;
  };
  readonly membership?: Membership;
  readonly portable?: false;
};
type SnapshotSource = {
  get(): Promise<SnapshotV2 | string> | SnapshotV2 | string;
  subscribe?(listener: () => void): () => void;
};
type PortableCondition = Condition;
type WhereCompiler<TTarget, TOptions = unknown> = (condition: PortableCondition, target: TTarget, options?: TOptions) => unknown;
type LimitStore = {
  consume(input: {
    readonly key: string;
    readonly subjectId: string;
    readonly count: number;
    readonly per: string;
  }): Promise<{
    readonly remaining: number;
  }> | {
    readonly remaining: number;
  };
};
type DecisionSink = {
  write(events: readonly DecisionEvent[]): Promise<void> | void;
  flush?(): Promise<void>;
};
type DecisionEvent = {
  readonly type: "decision";
  readonly at: string;
  readonly outcome: "granted" | "denied" | "approval-required";
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
    } | null;
    readonly actor?: {
      readonly id: string;
      readonly kind: string;
    };
    readonly delegation?: {
      readonly scopes?: readonly string[];
      readonly authorizationDetails?: readonly unknown[];
    };
  };
  readonly tenant?: string;
  readonly membership?: Membership;
  readonly via?: string | null;
  readonly matched?: {
    readonly role: string;
    readonly permission: string;
  };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly token?: string;
  readonly trusted: boolean;
  readonly source: "can" | "decide" | "assert" | "filter" | "endpoint" | "adapter" | "approval" | "simulate";
  readonly adapter?: string;
  readonly phase?: "requested" | "resolved";
  readonly counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  };
};
type AuthEvent = {
  readonly reason: "invalid-token" | "schema" | "unknown-role" | "groups-overflow" | "source-threw";
  readonly cause?: string;
  readonly source: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly typ?: string;
  readonly issuer?: string;
  readonly requestId?: string;
};
declare function memoryRoleSource(customRoles: readonly CustomRole[]): RoleSource;
//#endregion
export { GnapAccess as A, OpaqueCondition as C, Binding as D, AuthorizationDetail as E, Principal as M, Subject as N, CustomRole as O, MemberOfCondition as S, Assurance as T, WhereCompiler as _, LimitStore as a, ConditionRef as b, SnapshotGrant as c, SubjectResolver as d, TokenFailureCause as f, VerifiedToken as g, VerificationFailure as h, JwtClaims as i, Membership as j, Delegation as k, SnapshotSource as l, TokenVerifier as m, DecisionEvent as n, MembershipSource as o, TokenSigner as p, DecisionSink as r, RoleSource as s, AuthEvent as t, SnapshotV2 as u, memoryRoleSource as v, Actor as w, ConditionValue as x, Condition as y };