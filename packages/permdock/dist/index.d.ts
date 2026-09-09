import { a as CustomRole, d as Subject, i as Binding, l as Membership, n as Assurance, o as Delegation, r as AuthorizationDetail, s as GnapAccess, t as Actor, u as Principal } from "./subject-BcgWbogX.js";
import { $ as ResourceOptions, A as SnapshotV2, B as Decision, C as LimitRemaining, D as SinkEvent, E as RoleSource, F as VerificationFailure, G as MatchedGrant, H as DenialReason, I as VerifiedToken, J as Permission, K as ActionList, L as WhereCompiler, M as TokenFailureCause, N as TokenSigner, O as SnapshotGrant, P as TokenVerifier, Q as ResourceNode, R as memoryRoleSource, S as LimitConsumeInput, T as MembershipSource, U as DeniedDecision, V as Denial, W as GrantedDecision, X as PermissionTree, Y as PermissionKind, Z as ResourceInit, _ as DecisionEvent, a as GrantOptions, at as mergePermissions, b as DirectoryEvent, c as Role, ct as ConditionRef, d as ValidateMode, dt as OpaqueCondition, et as ResourceParent, f as allow, g as AuthEvent, h as role, i as GrantCondition, it as listPermissions, j as SubjectResolver, k as SnapshotSource, l as RoleOptions, lt as ConditionValue, m as deny, n as ClosureGrantFn, nt as findPermission, o as Policy, ot as resource, p as definePolicy, q as ActionMeta, r as Grant, rt as getResource, s as PrincipalOf, st as Condition, t as ClosureContext, tt as definePermissions, u as SubjectOf, ut as MemberOfCondition, v as DecisionProvider, w as LimitStore, y as DecisionSink, z as ApprovalRequiredDecision } from "./policy-B9ZJilUm.js";
import { i as ProblemDetails, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-ojKVwrw-.js";
import { _ as simulateArazzo, a as WhereResult, c as fromSnapshot, d as describe, f as ArazzoFinding, g as arazzoFindings, h as ArazzoStepResult, i as RowPair, l as parseSnapshot, m as ArazzoSimulateInput, n as DecideOptions, o as createPermDock, p as ArazzoPlan, r as PermDock, s as emptySnapshot, t as CreatePermDockOptions, u as DecisionDescription } from "./permdock-Dzaw5_Cl.js";
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
//#region src/core/limits.d.ts
export declare function memoryLimitStore(): LimitStore;
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
type CloudEventType = "dev.permdock.decision" | "dev.permdock.approval" | "dev.permdock.directory" | "dev.permdock.catalog";
type CloudEvent = {
  readonly specversion: "1.0";
  readonly type: CloudEventType;
  readonly source: string;
  readonly subject?: string;
  readonly id: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly data: SinkEvent;
};
type SignDecisionBatchOptions = {
  readonly audience?: string | readonly string[];
  readonly source?: string;
};
type MemorySinkOptions = {
  readonly capacity?: number;
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
  readonly source?: string;
};
type MemorySink = DecisionSink & {
  readonly events: () => readonly SinkEvent[];
  readonly batches: () => readonly string[];
};
export declare function toCloudEvent(event: SinkEvent, source?: string): CloudEvent;
export declare function signDecisionBatch(events: readonly SinkEvent[], signer: TokenSigner, options?: SignDecisionBatchOptions): Promise<string>;
export declare function memorySink(options?: MemorySinkOptions): MemorySink;
//#endregion
export { type ActionMeta, type Actor, type ApprovalRequiredDecision, type ArazzoFinding, type ArazzoPlan, type ArazzoSimulateInput, type ArazzoStepResult, type Assurance, type AuthEvent, type AuthorizationDetail, type Binding, type ClosureContext, type ClosureGrantFn, type CloudEvent, type CloudEventType, type Condition, type ConditionRef, type ConditionValue, type CreatePermDockOptions, type CustomRole, type DecideOptions, type Decision, type DecisionDescription, type DecisionEvent, type DecisionProvider, type DecisionSink, type Delegation, type Denial, type DenialReason, type DeniedDecision, type DirectoryEvent, type GnapAccess, type Grant, type GrantCondition, type GrantOptions, type GrantedDecision, type LimitConsumeInput, type LimitRemaining, type LimitStore, type MatchedGrant, type MemberOfCondition, type Membership, type MembershipSource, type MemorySink, type MemorySinkOptions, type PermDock, PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, type Permission, type PermissionKind, type PermissionTree, type Policy, type Principal, type PrincipalOf, type ProblemDetails, type ResourceInit, type ResourceNode, type ResourceOptions, type ResourceParent, type Role, type RoleOptions, type RoleSource, type RowPair, type SignDecisionBatchOptions, type SinkEvent, type SnapshotGrant, type SnapshotSource, type SnapshotV2, type Subject, type SubjectOf, type SubjectResolver, type TokenFailureCause, type TokenSigner, type TokenVerifier, type ValidateMode, type VerificationFailure, type VerifiedToken, type WhereCompiler, type WhereResult, allow, arazzoFindings, createPermDock, definePermissions, definePolicy, deny, describe, emptySnapshot, findPermission, fromSnapshot, getResource, listPermissions, memoryRoleSource, mergePermissions, parseSnapshot, resource, role, simulateArazzo };