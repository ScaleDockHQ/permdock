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
//#region src/conditions/opaque.d.ts
export declare function opaque(input: {
  readonly sql: string;
  readonly fingerprint: string;
}): OpaqueCondition;
//#endregion
//#region src/conditions/refs.d.ts
type SubjectRef = ConditionRef & {
  readonly [key: string]: SubjectRef;
};
export declare const subject: SubjectRef;
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
export declare function resource<T, const A extends ActionList = readonly [], const C extends ActionList = readonly []>(schema: StandardSchemaV1<unknown, T>, options?: ResourceOptions<A, C>): ResourceInit<T, A, C>;
export declare function resource<const A extends ActionList = readonly [], const C extends ActionList = readonly []>(options: ResourceOptions<A, C>): ResourceInit<unknown, A, C>;
export declare function getResource(tree: PermissionTree, name: string): ResourceNode | undefined;
export declare function definePermissions<const Input>(input: Input): InferPermissionTree<Input> & RegistryTree;
export declare function listPermissions(tree: PermissionTree | Permission): readonly Permission[];
export declare function findPermission(tree: PermissionTree, keyOrScope: string): Permission | undefined;
export declare function mergePermissions<const Trees extends readonly PermissionTree[]>(...trees: Trees): PermissionTree & RegistryTree;
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
export declare function allow<T, K extends PermissionKind = PermissionKind>(permission: Permission<string, T, K> | readonly Permission<string, T, K>[], condition?: GrantCondition<T, K>): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
export declare function deny<T, K extends PermissionKind = PermissionKind>(permission: Permission<string, T, K> | readonly Permission<string, T, K>[], condition?: GrantCondition<T, K>): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
export declare function role(name: string, grants: readonly (Omit<Grant, "role" | "scope"> | readonly Omit<Grant, "role" | "scope">[])[], options?: RoleOptions): Role;
export declare function definePolicy<TUser, TPrincipal extends Principal>(permissions: PermissionTree, options: {
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
//#region src/core/describe.d.ts
type DecisionDescription = {
  readonly kind: "granted" | "denied" | "approval" | "tenant" | "delegation" | "server-only";
  readonly title: string;
  readonly detail: string;
  readonly alternatives: readonly Permission[];
};
export declare function describe(decision: Decision): DecisionDescription;
//#endregion
//#region src/core/errors.d.ts
type ProblemDetails = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly permission?: string;
  readonly scope?: string;
  readonly resource?: {
    readonly type: string;
    readonly id?: string;
  };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly reason?: string;
  readonly token?: string;
  readonly issues?: readonly StandardSchemaV1.Issue[];
};
export declare class PermDockDeniedError extends Error {
  override readonly name: "PermDockDeniedError";
  readonly decision: Extract<Decision, {
    readonly outcome: "denied";
  }>;
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: Subject;
  constructor(input: {
    readonly decision: Extract<Decision, {
      readonly outcome: "denied";
    }>;
    readonly permission: string;
    readonly scope: string;
    readonly resource: {
      readonly type: string;
      readonly id?: string;
    };
    readonly subject: Subject;
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
export declare class PermDockApprovalRequiredError extends Error {
  override readonly name: "PermDockApprovalRequiredError";
  readonly decision: Extract<Decision, {
    readonly outcome: "approval-required";
  }>;
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly token: string;
  readonly reason: string;
  constructor(input: {
    readonly decision: Extract<Decision, {
      readonly outcome: "approval-required";
    }>;
    readonly permission: string;
    readonly scope: string;
    readonly resource: {
      readonly type: string;
      readonly id?: string;
    };
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
export declare class PermDockValidationError extends Error {
  override readonly name: "PermDockValidationError";
  readonly code: "invalid-data" | "async-schema" | "no-schema";
  readonly permission: string;
  readonly resource: string;
  readonly issues: readonly StandardSchemaV1.Issue[];
  readonly boundary: string;
  constructor(input: {
    readonly code: "invalid-data" | "async-schema" | "no-schema";
    readonly permission: string;
    readonly resource: string;
    readonly issues?: readonly StandardSchemaV1.Issue[];
    readonly boundary: string;
    readonly message: string;
  });
  toProblemDetails(options?: {
    readonly instance?: string;
  }): ProblemDetails;
}
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
export declare function memoryRoleSource(customRoles: readonly CustomRole[]): RoleSource;
//#endregion
//#region src/core/snapshot.d.ts
export declare function parseSnapshot(json: unknown): SnapshotV2;
//#endregion
//#region src/core/validation.d.ts
type Boundary = "http-body" | "mcp-args" | "tool-args" | "decision-endpoint" | "manual";
//#endregion
//#region src/core/permdock.d.ts
type DecideOptions = {
  readonly trusted?: boolean;
  readonly boundary?: Boundary;
  readonly now?: number;
  readonly source?: DecisionEvent["source"];
  readonly adapter?: string;
  readonly onDenied?: (decision: Decision) => never | void;
};
type RowPair<T> = {
  readonly current: T;
  readonly next: T;
};
type WhereResult = {
  readonly condition: Condition | {
    readonly op: "or";
    readonly conditions: readonly [];
  };
  readonly partial: boolean;
};
type PermDock = {
  readonly can: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): boolean;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): boolean;
  };
  readonly decide: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): Decision;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): Decision;
  };
  readonly assert: {
    (permission: Permission<string, unknown, "instance">, data: unknown, options?: DecideOptions): Extract<Decision, {
      readonly outcome: "granted";
    }>;
    (permission: Permission<string, unknown, "collection">, data?: unknown, options?: DecideOptions): Extract<Decision, {
      readonly outcome: "granted";
    }>;
  };
  readonly filter: <T>(permission: Permission<string, T, "instance">, rows: readonly T[], options?: DecideOptions) => T[];
  readonly where: (permission: Permission) => WhereResult;
  readonly simulate: {
    (checks: readonly (readonly [Permission, unknown?])[]): Decision[];
    (preview: {
      readonly roles?: readonly string[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PermDock;
  };
  readonly snapshot: (options?: {
    readonly include?: readonly (Permission | {
      readonly [key: string]: unknown;
    })[];
    readonly tenants?: "all";
    readonly signer?: TokenSigner;
    readonly audience?: string | readonly string[];
  }) => SnapshotV2 | Promise<string>;
  readonly on: (event: "decision" | "denied" | "approval" | "auth" | "error", handler: (payload: unknown) => void) => () => void;
  readonly tenant: (id: string) => PermDock;
  readonly team: (id: string) => PermDock;
  readonly memberships: () => readonly Membership[];
  readonly tenants: () => readonly string[];
  readonly roles: (options?: {
    readonly tenant?: string;
  }) => readonly string[];
  readonly assignable: () => readonly string[];
  readonly subject: Subject;
};
type CreatePermDockOptions = {
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  readonly session?: string;
  readonly expiresAt?: number;
};
export declare function createPermDock(policy: Policy, user: unknown, options?: CreatePermDockOptions): PermDock | Promise<PermDock>;
//#endregion
//#region src/core/sink.d.ts
export declare function memorySink(options?: {
  readonly capacity?: number;
}): DecisionSink & {
  readonly events: () => readonly DecisionEvent[];
};
//#endregion
export type { ActionMeta, Actor, ApprovalRequiredDecision, Assurance, AuthEvent, AuthorizationDetail, Binding, ClosureContext, ClosureGrantFn, Condition, ConditionRef, ConditionValue, CreatePermDockOptions, CustomRole, DecideOptions, Decision, DecisionDescription, DecisionEvent, DecisionSink, Delegation, Denial, DenialReason, DeniedDecision, GnapAccess, Grant, GrantCondition, GrantOptions, GrantedDecision, LimitStore, MatchedGrant, MemberOfCondition, Membership, MembershipSource, PermDock, Permission, PermissionKind, PermissionTree, Policy, Principal, PrincipalOf, ProblemDetails, ResourceInit, ResourceNode, ResourceOptions, ResourceParent, Role, RoleOptions, RoleSource, RowPair, SnapshotGrant, SnapshotSource, SnapshotV2, Subject, SubjectOf, SubjectResolver, TokenFailureCause, TokenSigner, TokenVerifier, ValidateMode, VerificationFailure, VerifiedToken, WhereCompiler, WhereResult };