import { A as ConditionRef, C as CustomRole, D as Principal, E as Membership, M as MemberOfCondition, N as OpaqueCondition, O as Subject, S as Binding, T as GnapAccess, _ as WhereCompiler, a as LimitStore, b as Assurance, c as SnapshotGrant, d as SubjectResolver, f as TokenFailureCause, g as VerifiedToken, h as VerificationFailure, j as ConditionValue, k as Condition, l as SnapshotSource, m as TokenVerifier, n as DecisionEvent, o as MembershipSource, p as TokenSigner, r as DecisionSink, s as RoleSource, t as AuthEvent, u as SnapshotV2, v as memoryRoleSource, w as Delegation, x as AuthorizationDetail, y as Actor } from "./interfaces-D45oN5-b.js";
import { A as ResourceOptions, C as ActionList, D as PermissionTree, E as PermissionKind, F as listPermissions, I as mergePermissions, L as resource, M as definePermissions, N as findPermission, O as ResourceInit, P as getResource, S as role, T as Permission, _ as SubjectOf, a as DeniedDecision, b as definePolicy, c as ClosureContext, d as GrantCondition, f as GrantOptions, g as RoleOptions, h as Role, i as DenialReason, j as ResourceParent, k as ResourceNode, l as ClosureGrantFn, m as PrincipalOf, n as Decision, o as GrantedDecision, p as Policy, r as Denial, s as MatchedGrant, t as ApprovalRequiredDecision, u as Grant, v as ValidateMode, w as ActionMeta, x as deny, y as allow } from "./decision-JylG_mtz.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
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
//#region src/core/presets.d.ts
type ReadOnlyMeta = {
  readonly readOnly: true;
};
type DestructiveMeta = {
  readonly tags: readonly ["destructive"];
};
type CrudActions = {
  readonly read: ReadOnlyMeta;
  readonly update: ActionMeta;
  readonly delete: DestructiveMeta;
};
type CrudCollection = {
  readonly create: ActionMeta;
  readonly list: ReadOnlyMeta;
};
type ReadableActions = {
  readonly read: ReadOnlyMeta;
};
type ReadableCollection = {
  readonly list: ReadOnlyMeta;
};
type WritableActions = {
  readonly read: ReadOnlyMeta;
  readonly update: ActionMeta;
};
declare const CRUD_ACTIONS: CrudActions;
declare const CRUD_COLLECTION: CrudCollection;
declare const READABLE_ACTIONS: ReadableActions;
declare const READABLE_COLLECTION: ReadableCollection;
declare const WRITABLE_ACTIONS: WritableActions;
declare const WRITABLE_COLLECTION: Record<never, never>;
type EmptyRecord = Record<never, never>;
type ActionNames<A extends ActionList | undefined> = A extends readonly string[] ? A[number] & string : A extends Record<string, ActionMeta> ? keyof A & string : never;
type ToActionRecord<A extends ActionList | undefined> = [ActionNames<A>] extends [never] ? EmptyRecord : { readonly [K in ActionNames<A>]: ActionMeta; };
type OverlayMeta<Base extends ActionMeta, Extra extends ActionMeta> = Omit<Base, keyof Extra> & Extra;
type MergeActionRecords<Base extends Record<string, ActionMeta>, Extra extends Record<string, ActionMeta>> = { readonly [K in keyof Base | keyof Extra]: K extends keyof Extra ? K extends keyof Base ? OverlayMeta<Base[K] & ActionMeta, Extra[K] & ActionMeta> : Extra[K] & ActionMeta : K extends keyof Base ? Base[K] & ActionMeta : never; };
type PresetOptions<A extends ActionList | undefined = undefined, C extends ActionList | undefined = undefined> = {
  readonly id?: string;
  readonly parent?: ResourceParent;
  readonly actions?: A;
  readonly collection?: C;
};
type PresetResult<BaseA extends Record<string, ActionMeta>, BaseC extends Record<string, ActionMeta>, A extends ActionList | undefined, C extends ActionList | undefined> = {
  readonly id?: string;
  readonly parent?: ResourceParent;
  readonly actions: MergeActionRecords<BaseA, ToActionRecord<A>>;
  readonly collection?: MergeActionRecords<BaseC, ToActionRecord<C>>;
};
export declare function crud<const A extends ActionList | undefined = undefined, const C extends ActionList | undefined = undefined>(options?: PresetOptions<A, C>): PresetResult<typeof CRUD_ACTIONS, typeof CRUD_COLLECTION, A, C>;
export declare function readable<const A extends ActionList | undefined = undefined, const C extends ActionList | undefined = undefined>(options?: PresetOptions<A, C>): PresetResult<typeof READABLE_ACTIONS, typeof READABLE_COLLECTION, A, C>;
export declare function writable<const A extends ActionList | undefined = undefined, const C extends ActionList | undefined = undefined>(options?: PresetOptions<A, C>): PresetResult<typeof WRITABLE_ACTIONS, typeof WRITABLE_COLLECTION, A, C>;
//#endregion
//#region src/core/sink.d.ts
export declare function memorySink(options?: {
  readonly capacity?: number;
}): DecisionSink & {
  readonly events: () => readonly DecisionEvent[];
};
//#endregion
export { type ActionMeta, type Actor, type ApprovalRequiredDecision, type Assurance, type AuthEvent, type AuthorizationDetail, type Binding, type ClosureContext, type ClosureGrantFn, type Condition, type ConditionRef, type ConditionValue, type CreatePermDockOptions, type CustomRole, type DecideOptions, type Decision, type DecisionDescription, type DecisionEvent, type DecisionSink, type Delegation, type Denial, type DenialReason, type DeniedDecision, type GnapAccess, type Grant, type GrantCondition, type GrantOptions, type GrantedDecision, type LimitStore, type MatchedGrant, type MemberOfCondition, type Membership, type MembershipSource, type PermDock, type Permission, type PermissionKind, type PermissionTree, type Policy, type Principal, type PrincipalOf, type ProblemDetails, type ResourceInit, type ResourceNode, type ResourceOptions, type ResourceParent, type Role, type RoleOptions, type RoleSource, type RowPair, type SnapshotGrant, type SnapshotSource, type SnapshotV2, type Subject, type SubjectOf, type SubjectResolver, type TokenFailureCause, type TokenSigner, type TokenVerifier, type ValidateMode, type VerificationFailure, type VerifiedToken, type WhereCompiler, type WhereResult, allow, definePermissions, definePolicy, deny, findPermission, getResource, listPermissions, memoryRoleSource, mergePermissions, resource, role };