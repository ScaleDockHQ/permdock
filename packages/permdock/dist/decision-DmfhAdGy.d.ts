import { StandardSchemaV1 } from "@standard-schema/spec";
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
type TokenFailureCause = "expired" | "not-yet-valid" | "invalid-signature" | "invalid-typ" | "invalid-issuer" | "invalid-audience" | "algorithm-not-allowed" | "missing-key" | "malformed";
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
};
declare function memoryRoleSource(customRoles: readonly CustomRole[]): RoleSource;
//#endregion
//#region src/core/permissions.d.ts
declare const RESOURCE_BRAND: unique symbol;
declare const TREE_REGISTRY: unique symbol;
declare const TREE_LEAVES: unique symbol;
type ActionMeta = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
};
type PermissionKind = "instance" | "collection";
type Permission<K extends string = string, T = unknown, Kind extends PermissionKind = PermissionKind> = {
  readonly key: K;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly meta: ActionMeta;
  readonly kind: Kind;
} & ([T] extends [never] ? unknown : unknown);
type ResourceParent = {
  readonly field: string;
  readonly resource: string;
};
type ActionList = readonly string[] | Record<string, ActionMeta>;
type ResourceOptions<A extends ActionList | undefined = ActionList | undefined, C extends ActionList | undefined = ActionList | undefined> = {
  readonly id?: string;
  readonly actions?: A;
  readonly collection?: C;
  readonly parent?: ResourceParent;
};
type ResourceInit<T = unknown, A extends ActionList | undefined = ActionList | undefined, C extends ActionList | undefined = ActionList | undefined> = {
  readonly [RESOURCE_BRAND]: true;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly options: ResourceOptions<A, C>;
};
type ResourceNode<T = unknown> = {
  readonly name: string;
  readonly path: string;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly id: string;
  readonly parent: ResourceParent | undefined;
  readonly instanceActions: ReadonlySet<string>;
  readonly collectionActions: ReadonlySet<string>;
};
type PermissionTree = {
  readonly [key: string]: PermissionTree | Permission;
};
type RegistryTree = PermissionTree & {
  readonly [TREE_REGISTRY]: ReadonlyMap<string, ResourceNode>;
  readonly [TREE_LEAVES]: readonly Permission[];
};
type ActionNames<A extends ActionList | undefined> = A extends readonly string[] ? A[number] : A extends Record<string, ActionMeta> ? keyof A & string : never;
type LeavesFrom<Prefix extends string, Names extends string, T, Kind extends PermissionKind> = [Names] extends [never] ? object : { readonly [K in Names]: Permission<Prefix extends "" ? K : `${Prefix}.${K}`, T, Kind>; };
type InferResourceLeaves<R extends ResourceInit, Prefix extends string> = R extends ResourceInit<infer T, infer A, infer C> ? LeavesFrom<Prefix, ActionNames<A>, T, "instance"> & LeavesFrom<Prefix, ActionNames<C>, T, "collection"> : object;
type InferPermissionTree<Input, Prefix extends string = ""> = Input extends ResourceInit ? InferResourceLeaves<Input, Prefix> : Input extends Record<string, unknown> ? { readonly [K in keyof Input & string]: InferPermissionTree<Input[K], Prefix extends "" ? K : `${Prefix}.${K}`>; } : never;
declare function resource<T, const A extends ActionList = readonly [], const C extends ActionList = readonly []>(schema: StandardSchemaV1<unknown, T>, options?: ResourceOptions<A, C>): ResourceInit<T, A, C>;
declare function resource<const A extends ActionList = readonly [], const C extends ActionList = readonly []>(options: ResourceOptions<A, C>): ResourceInit<unknown, A, C>;
declare function getResource(tree: PermissionTree, name: string): ResourceNode | undefined;
declare function definePermissions<const Input>(input: Input): InferPermissionTree<Input> & RegistryTree;
declare function listPermissions(tree: PermissionTree | Permission): readonly Permission[];
declare function findPermission(tree: PermissionTree, keyOrScope: string): Permission | undefined;
declare function mergePermissions<const Trees extends readonly PermissionTree[]>(...trees: Trees): PermissionTree & RegistryTree;
//#endregion
//#region src/conditions/normalize.d.ts
type FieldOperator = {
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
type WhereShorthand<T = Record<string, unknown>> = {
  readonly and?: readonly WhereShorthand<T>[];
  readonly or?: readonly WhereShorthand<T>[];
  readonly not?: WhereShorthand<T>;
} & { readonly [K in keyof T]?: T[K] | FieldOperator | {
  readonly ref: string;
}; };
//#endregion
//#region src/core/policy.d.ts
type ClosureContext = {
  readonly subject: {
    readonly principal: Principal | null;
    readonly actor?: unknown;
    readonly delegation?: unknown;
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly actor?: unknown;
  readonly delegation?: unknown;
  readonly context: Readonly<Record<string, unknown>>;
};
type ClosureGrantFn<T = unknown> = (data: T, ctx: ClosureContext) => boolean;
type GrantOptions<T = Record<string, unknown>> = {
  readonly where?: WhereShorthand<T> | Condition;
  readonly check?: WhereShorthand<T> | Condition;
  readonly approval?: "human";
  readonly limit?: {
    readonly count: number;
    readonly per: string;
  };
  readonly reason?: string;
};
type RoleScope = "tenant" | "team" | Permission | PermissionTree | readonly (Permission | PermissionTree)[];
type RoleOptions = {
  readonly on?: RoleScope;
  readonly assignable?: boolean;
};
type Grant = {
  readonly permission: Permission;
  readonly effect: "allow" | "deny";
  readonly role: string;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human";
  readonly portable: boolean;
  readonly closure?: ClosureGrantFn;
  readonly limit?: {
    readonly count: number;
    readonly per: string;
  };
  readonly scope: "global" | "tenant" | "team" | {
    readonly resource: string;
  };
};
type Role = {
  readonly name: string;
  readonly grants: readonly Grant[];
  readonly on?: RoleScope;
  readonly assignable: boolean;
};
type ValidateMode = "boundary" | "always" | "never";
type PolicyScopes = {
  readonly tenant?: {
    readonly key: string;
  };
  readonly team?: {
    readonly key: string;
  };
};
type Policy<TUser = unknown, TPrincipal extends Principal = Principal> = {
  readonly permissions: PermissionTree;
  readonly roles: readonly Role[];
  readonly rolesByName: ReadonlyMap<string, Role>;
  readonly scopes: PolicyScopes;
  readonly subject: (user: TUser) => TPrincipal | null;
  readonly context?: (user: TUser) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  readonly validate: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly fingerprint: string;
  readonly resources: ReadonlyMap<string, ResourceNode>;
};
type GrantCondition<T, K extends PermissionKind> = K extends "collection" ? Omit<GrantOptions<T>, "where"> | ClosureGrantFn<T> : GrantOptions<T> | ClosureGrantFn<T>;
declare function allow<T, K extends PermissionKind = PermissionKind>(permission: Permission<string, T, K> | readonly Permission<string, T, K>[], condition?: GrantCondition<T, K>): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
declare function deny<T, K extends PermissionKind = PermissionKind>(permission: Permission<string, T, K> | readonly Permission<string, T, K>[], condition?: GrantCondition<T, K>): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
declare function role(name: string, grants: readonly (Omit<Grant, "role" | "scope"> | readonly Omit<Grant, "role" | "scope">[])[], options?: RoleOptions): Role;
declare function definePolicy<TUser, TPrincipal extends Principal>(permissions: PermissionTree, options: {
  readonly roles: readonly Role[];
  readonly scopes?: PolicyScopes;
  readonly subject: (user: TUser) => TPrincipal | null;
  readonly context?: (user: TUser) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  readonly validate?: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
}): Policy<TUser, TPrincipal>;
type PrincipalOf<P> = P extends Policy<unknown, infer TPrincipal> ? TPrincipal : Principal;
type SubjectOf<P> = {
  readonly principal: PrincipalOf<P> | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};
//#endregion
//#region src/core/decision.d.ts
type DenialReason = "no-grant" | "condition" | "deny" | "closure-error" | "opaque-condition" | "anonymous" | "not-delegated" | "no-delegation" | "insufficient-user-authentication" | "limit" | "validation" | "tenant-mismatch" | "no-membership" | "scope" | "expired-membership" | "unknown-role" | "approval";
type Denial = {
  readonly role: string | null;
  readonly reason: DenialReason;
  readonly detail?: unknown;
};
type MatchedGrant = {
  readonly role: string;
  readonly permission: string;
  readonly where?: Grant["where"];
  readonly check?: Grant["check"];
  readonly approval?: "human";
};
type GrantedDecision = {
  readonly outcome: "granted";
  readonly subject: Subject & {
    readonly principal: NonNullable<Subject["principal"]>;
  };
  readonly matched: MatchedGrant;
  readonly token: string;
};
type DeniedDecision = {
  readonly outcome: "denied";
  readonly denials: readonly Denial[];
  readonly alternatives: readonly Permission[];
};
type ApprovalRequiredDecision = {
  readonly outcome: "approval-required";
  readonly grant: MatchedGrant;
  readonly reason: "human";
  readonly token: string;
};
type Decision = GrantedDecision | DeniedDecision | ApprovalRequiredDecision;
//#endregion
export { WhereCompiler as $, ResourceOptions as A, DecisionSink as B, ActionList as C, PermissionTree as D, PermissionKind as E, listPermissions as F, SnapshotSource as G, MembershipSource as H, mergePermissions as I, TokenFailureCause as J, SnapshotV2 as K, resource as L, definePermissions as M, findPermission as N, ResourceInit as O, getResource as P, VerifiedToken as Q, AuthEvent as R, role as S, Permission as T, RoleSource as U, LimitStore as V, SnapshotGrant as W, TokenVerifier as X, TokenSigner as Y, VerificationFailure as Z, SubjectOf as _, DeniedDecision as a, CustomRole as at, definePolicy as b, ClosureContext as c, Membership as ct, GrantCondition as d, Condition as dt, memoryRoleSource as et, GrantOptions as f, ConditionRef as ft, RoleOptions as g, Role as h, OpaqueCondition as ht, DenialReason as i, Binding as it, ResourceParent as j, ResourceNode as k, ClosureGrantFn as l, Principal as lt, PrincipalOf as m, MemberOfCondition as mt, Decision as n, Assurance as nt, GrantedDecision as o, Delegation as ot, Policy as p, ConditionValue as pt, SubjectResolver as q, Denial as r, AuthorizationDetail as rt, MatchedGrant as s, GnapAccess as st, ApprovalRequiredDecision as t, Actor as tt, Grant as u, Subject as ut, ValidateMode as v, ActionMeta as w, deny as x, allow as y, DecisionEvent as z };