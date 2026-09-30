export { context, principal } from './conditions/index.ts';
export { opaque } from './conditions/opaque.ts';
export { sqlFunction } from './conditions/sql-function.ts';
export type {
  Condition,
  ConditionRef,
  ConditionValue,
  MemberOfCondition,
  MemberOfParent,
  RelatedCondition,
  RelatedHop,
  SqlFunctionArg,
  SqlFunctionCondition,
} from './conditions/ast.ts';
export {
  hasConditionOp,
  isCondition,
  isConditionDate,
  isConditionRef,
  isSqlFunctionField,
} from './conditions/ast.ts';
export { describe, requiredPlans } from './core/describe.ts';
export type { DecisionDescription } from './core/describe.ts';
export type {
  ApprovalRequiredDecision,
  Decision,
  Denial,
  DenialReason,
  DeniedDecision,
  GrantedDecision,
  LimitDetail,
  MatchedGrant,
  Obligation,
  Quota,
} from './core/decision.ts';
export type { WireDecision, WireDenial } from './core/wire-denial.ts';
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from './core/errors.ts';
export type { ProblemDetails, RevokedCode } from './core/errors.ts';
export { parsePermDockDigest } from './core/digest.ts';
export type { PermDockDigest } from './core/digest.ts';
export { memoryRevocationFeed } from './core/revocations.ts';
export type {
  RevocationEvent,
  RevocationFeed,
  RevocationListener,
} from './core/revocations.ts';
export {
  memoryEntitlementSource,
  memoryRoleSource,
  memorySettings,
} from './core/interfaces.ts';
export {
  claimsFirst,
  composeMemberships,
  isExternallyManaged,
} from './core/memberships.ts';
export { fromStripeEntitlements } from './core/stripe-entitlements.ts';
export type { StripeEntitlementsClient } from './core/stripe-entitlements.ts';
export { memoryLimitStore } from './core/limits.ts';
export { memoryRelations } from './core/relations.ts';
export type { MemoryEdge, MemoryRelationsData } from './core/relations.ts';
export type { Holder, HoldingVia, WhoCan } from './core/who-can.ts';
export {
  isPortableCondition,
  memoryPolicySource,
  mergeHostedGrants,
  parsePolicyDocument,
} from './core/hosted.ts';
export type {
  HostedGrant,
  HostedGrantDropReason,
  HostedGrantDropped,
  PolicyDocument,
  PolicySource,
} from './core/hosted.ts';
export type {
  AccessEvent,
  AuthEvent,
  CredentialEvent,
  CredentialVerifier,
  DecisionEvent,
  DecisionProvider,
  DecisionSink,
  DirectoryEvent,
  MembershipEvent,
  LimitConsumeInput,
  LimitRemaining,
  LimitStore,
  SinkEvent,
  EntitlementSource,
  MemberEntry,
  MembershipSource,
  RelationChain,
  RelationGroup,
  RelationHolder,
  RelationSource,
  RoleSource,
  SettingsSource,
  Snapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotNotEntitled,
  SnapshotScope,
  SnapshotSource,
  SubjectResolver,
  TenantSettings,
  TokenFailureCause,
  TokenSigner,
  TokenVerifier,
  VerificationFailure,
  VerifiedToken,
  WhereCompiler,
} from './core/interfaces.ts';
export { arazzoFindings, simulateArazzo } from './core/arazzo.ts';
export type {
  ArazzoFinding,
  ArazzoPlan,
  ArazzoSimulateInput,
  ArazzoStepResult,
} from './core/arazzo.ts';
export { emptySnapshot, fromSnapshot } from './core/from-snapshot.ts';
export { createPermDock, parseSnapshot } from './core/permdock.ts';
export { mayAccess } from './core/may-access.ts';
export { mayUse } from './core/may-use.ts';
export {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from './core/custom-roles.ts';
export type {
  CustomRoleDrop,
  CustomRoleDropReason,
  CustomRoleValidation,
  ResolvedCustomRole,
} from './core/custom-roles.ts';
export { snapshotFor } from './core/snapshot-for.ts';
export type { SnapshotForOptions } from './core/snapshot-for.ts';
export type {
  CreatePermDockOptions,
  DecideOptions,
  PermDock,
  RowPair,
  WhereResult,
} from './core/permdock.ts';
export {
  definePermissions,
  findPermission,
  getResource,
  listPermissions,
  mergePermissions,
  resource,
} from './core/permissions.ts';
export { crud, readable, writable } from './core/presets.ts';
export type {
  ActionMeta,
  Permission,
  PermissionKind,
  PermissionTree,
  ResourceInit,
  ResourceNode,
  ResourceOptions,
  ComputedRelation,
  EdgeGroups,
  EdgeMatch,
  EdgeRelation,
  FieldRelation,
  PrincipalRelation,
  ResourceLink,
  ResourceParent,
  ResourceRelation,
  ResourceRelationInput,
} from './core/permissions.ts';
export {
  allow,
  definePolicy,
  deny,
  normalizeApproval,
  normalizeAssurance,
  requiresApproval,
  role,
  separationConflicts,
} from './core/policy.ts';
export type {
  ActivationOption,
  ApprovalOption,
  ApprovalRequirement,
  AssuranceRequirement,
  BreakGlassOptions,
  BreakGlassRequirements,
  BreakGlassSpec,
  ClosureContext,
  ClosureGrantFn,
  Grant,
  GrantCondition,
  GrantLimit,
  GrantOptions,
  GrantScope,
  HostedGrantRef,
  MembershipFixture,
  Policy,
  SeparationConflict,
  PrincipalOf,
  PolicyScopes,
  RoleBinding,
  RoleOptions,
  RoleScope,
  SubjectOf,
  SupportAccessOptions,
  SupportConsent,
  ValidateMode,
} from './core/policy.ts';
export { breakGlass, supportAccess } from './core/elevated.ts';
export type { ActivateInput } from './core/elevated.ts';
export { parseDuration } from './core/duration.ts';
export {
  actor,
  anyone,
  assurance,
  authenticated,
  plan,
  relation,
} from './core/grantee.ts';
export type { Grantee, GranteeInput, RelationGrantee } from './core/grantee.ts';
export type {
  PolicyScopesInput,
  Scope,
  ScopeDeclaration,
  ScopeNames,
} from './core/scopes.ts';
export {
  definePlans,
  defineRoles,
  findRole,
  isPlan,
  isRole,
  listPlans,
  listRoles,
} from './core/vocabulary.ts';
export type {
  Plan,
  PlanTree,
  Role,
  RoleMeta,
  RoleTree,
  Vocabulary,
} from './core/vocabulary.ts';
export type {
  RoleChange,
  RoleChangeDecision,
  RoleChangeTarget,
} from './core/ownership.ts';
export {
  CLOUD_EVENT_TYPES,
  accessEvent,
  credentialEvent,
  membershipEvent,
  memorySink,
  signDecisionBatch,
  toCloudEvent,
} from './core/sink.ts';
export type {
  CatalogEventData,
  CatalogFinding,
  CatalogFindingCode,
  CloudEvent,
  CloudEventType,
  MemorySink,
  MemorySinkOptions,
  SignDecisionBatchOptions,
} from './core/sink.ts';
export { OCSF_VERSION, accessToOcsf, toOcsf } from './core/ocsf.ts';
export { CSV_COLUMNS, toCsvRow } from './core/csv.ts';
export { catalogFingerprint } from './core/catalog-fingerprint.ts';
export { coveredByDelegation } from './core/delegation.ts';
export {
  capabilitySubject,
  linkPolicyViolation,
  parseCapability,
  signCapability,
} from './core/capability.ts';
export type {
  Capability,
  CapabilityInput,
  CapabilityRedeemer,
  LinkPolicy,
  LinkPolicyViolation,
  LinkPrincipal,
  SignCapabilityOptions,
} from './core/capability.ts';
export {
  credentialDelegation,
  credentialPolicyViolation,
  credentialSubject,
  decideCredential,
  parseCredential,
} from './core/credential.ts';
export type {
  Credential,
  CredentialDecision,
  CredentialKind,
  CredentialPermission,
  CredentialPermissionInput,
  CredentialPolicy,
  CredentialPolicyViolation,
  CredentialPrincipal,
  CredentialRequest,
  DecideCredentialOptions,
} from './core/credential.ts';
export type { OcsfAccountChange, OcsfAuthorizeSession } from './core/ocsf.ts';
export type {
  Actor,
  Assurance,
  AuthorizationDetail,
  Binding,
  CustomRole,
  CustomRoleGrant,
  Delegation,
  GnapAccess,
  Membership,
  Principal,
  Subject,
  VerifiedClaims,
} from './core/subject.ts';
