import { M as Principal, N as Subject, k as Delegation, w as Actor, y as Condition } from "./interfaces-CnUn1fRe.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
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
export { ResourceOptions as A, ActionList as C, PermissionTree as D, PermissionKind as E, listPermissions as F, mergePermissions as I, resource as L, definePermissions as M, findPermission as N, ResourceInit as O, getResource as P, role as S, Permission as T, SubjectOf as _, DeniedDecision as a, definePolicy as b, ClosureContext as c, GrantCondition as d, GrantOptions as f, RoleOptions as g, Role as h, DenialReason as i, ResourceParent as j, ResourceNode as k, ClosureGrantFn as l, PrincipalOf as m, Decision as n, GrantedDecision as o, Policy as p, Denial as r, MatchedGrant as s, ApprovalRequiredDecision as t, Grant as u, ValidateMode as v, ActionMeta as w, deny as x, allow as y };