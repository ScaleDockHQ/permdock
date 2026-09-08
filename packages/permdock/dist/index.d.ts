import { A as GnapAccess, C as OpaqueCondition, D as Binding, E as AuthorizationDetail, M as Principal, N as Subject, O as CustomRole, S as MemberOfCondition, T as Assurance, _ as WhereCompiler, a as LimitStore, b as ConditionRef, c as SnapshotGrant, d as SubjectResolver, f as TokenFailureCause, g as VerifiedToken, h as VerificationFailure, j as Membership, k as Delegation, l as SnapshotSource, m as TokenVerifier, n as DecisionEvent, o as MembershipSource, p as TokenSigner, r as DecisionSink, s as RoleSource, t as AuthEvent, u as SnapshotV2, v as memoryRoleSource, w as Actor, x as ConditionValue, y as Condition } from "./interfaces-CnUn1fRe.js";
import { A as resource, C as ResourceOptions, D as getResource, E as findPermission, O as listPermissions, S as ResourceNode, T as definePermissions, _ as ActionMeta, a as GrantOptions, b as PermissionTree, c as Role, d as ValidateMode, f as allow, g as ActionList, h as role, i as GrantCondition, k as mergePermissions, l as RoleOptions, m as deny, n as ClosureGrantFn, o as Policy, p as definePolicy, r as Grant, s as PrincipalOf, t as ClosureContext, u as SubjectOf, v as Permission, w as ResourceParent, x as ResourceInit, y as PermissionKind } from "./policy-d3iw76Re.js";
import { a as DeniedDecision, i as DenialReason, n as Decision, o as GrantedDecision, r as Denial, s as MatchedGrant, t as ApprovalRequiredDecision } from "./decision-koSOp9O_.js";
import { a as WhereResult, c as fromSnapshot, d as describe, i as RowPair, l as parseSnapshot, n as DecideOptions, o as createPermDock, r as PermDock, s as emptySnapshot, t as CreatePermDockOptions, u as DecisionDescription } from "./permdock-1gHf-BWb.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-BrBfS4h9.js";
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
export { type ActionMeta, type Actor, type ApprovalRequiredDecision, type Assurance, type AuthEvent, type AuthorizationDetail, type Binding, type ClosureContext, type ClosureGrantFn, type Condition, type ConditionRef, type ConditionValue, type CreatePermDockOptions, type CustomRole, type DecideOptions, type Decision, type DecisionDescription, type DecisionEvent, type DecisionSink, type Delegation, type Denial, type DenialReason, type DeniedDecision, type GnapAccess, type Grant, type GrantCondition, type GrantOptions, type GrantedDecision, type LimitStore, type MatchedGrant, type MemberOfCondition, type Membership, type MembershipSource, type PermDock, PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, type Permission, type PermissionKind, type PermissionTree, type Policy, type Principal, type PrincipalOf, type ProblemDetails, type ResourceInit, type ResourceNode, type ResourceOptions, type ResourceParent, type Role, type RoleOptions, type RoleSource, type RowPair, type SnapshotGrant, type SnapshotSource, type SnapshotV2, type Subject, type SubjectOf, type SubjectResolver, type TokenFailureCause, type TokenSigner, type TokenVerifier, type ValidateMode, type VerificationFailure, type VerifiedToken, type WhereCompiler, type WhereResult, allow, createPermDock, definePermissions, definePolicy, deny, describe, emptySnapshot, findPermission, fromSnapshot, getResource, listPermissions, memoryRoleSource, mergePermissions, parseSnapshot, resource, role };