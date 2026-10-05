export { context, principal } from "./conditions/index.ts";
export { opaque } from "./conditions/opaque.ts";
export { sqlFunction } from "./conditions/sql-function.ts";
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
} from "./conditions/ast.ts";
export {
  hasConditionOp,
  isCondition,
  isConditionDate,
  isConditionRef,
  isSqlFunctionField,
} from "./conditions/ast.ts";
export { describe, requiredPlans } from "./core/describe.ts";
export type {
  DecisionDescription,
  DescribeMessages,
  DescribeOptions,
} from "./core/describe.ts";
export type {
  ApprovalRequiredDecision,
  Decision,
  Denial,
  DenialReason,
  DeniedDecision,
  ExplainedDecision,
  GrantedDecision,
  LimitDetail,
  MatchedGrant,
  Obligation,
  Quota,
  Trace,
  TraceSkip,
  TraceSkipReason,
} from "./core/decision.ts";
export type { WireDecision, WireDenial } from "./core/wire-denial.ts";
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from "./core/errors.ts";
export type { ProblemDetails, RevokedCode } from "./core/errors.ts";
export { parsePermDockDigest } from "./core/digest.ts";
export type { PermDockDigest } from "./core/digest.ts";
export { memoryRevocationFeed } from "./core/revocations.ts";
export type {
  RevocationEvent,
  RevocationFeed,
  RevocationListener,
} from "./core/revocations.ts";
export {
  memoryEntitlementSource,
  memoryRoleSource,
  memorySettings,
} from "./core/interfaces.ts";
export {
  APPROVAL_POLICY_UNAVAILABLE,
  memoryApprovalPolicies,
  validateApprovalPolicy,
} from "./core/approval-policies.ts";
export type {
  ApprovalPolicy,
  ApprovalPolicyProblem,
  ApprovalPolicySource,
  ApprovalPolicyValidation,
} from "./core/approval-policies.ts";
export {
  claimsFirst,
  composeMemberships,
  isExternallyManaged,
} from "./core/memberships.ts";
export { fromStripeEntitlements } from "./core/stripe-entitlements.ts";
export type { StripeEntitlementsClient } from "./core/stripe-entitlements.ts";
export { memoryLimitStore } from "./core/limits.ts";
export { memoryRelations } from "./core/relations.ts";
export type { MemoryEdge, MemoryRelationsData } from "./core/relations.ts";
export type { Holder, HoldingVia, WhoCan } from "./core/who-can.ts";
export {
  isPortableCondition,
  memoryPolicySource,
  mergeHostedGrants,
  parsePolicyDocument,
} from "./core/hosted.ts";
export type {
  HostedGrant,
  HostedGrantDropReason,
  HostedGrantDropped,
  PolicyDocument,
  PolicySource,
} from "./core/hosted.ts";
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
  LocalCustomRoleTable,
  LocalSnapshotManifest,
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
  RoleSourceFactory,
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
} from "./core/interfaces.ts";
export { arazzoFindings, simulateArazzo } from "./core/arazzo.ts";
export type {
  ArazzoFinding,
  ArazzoPlan,
  ArazzoSimulateInput,
  ArazzoStepResult,
} from "./core/arazzo.ts";
export { emptySnapshot, fromSnapshot } from "./core/from-snapshot.ts";
export { localSnapshotManifest } from "./core/local-manifest.ts";
export { createPermDock, parseSnapshot } from "./core/permdock.ts";
export { mayAccess } from "./core/may-access.ts";
export { mayUse } from "./core/may-use.ts";
export {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from "./core/custom-roles.ts";
export { customRoleSource } from "./core/custom-role-source.ts";
export type {
  CustomRoleReader,
  CustomRoleSourceOptions,
} from "./core/custom-role-source.ts";
export type {
  CustomRoleDrop,
  CustomRoleDropReason,
  CustomRoleRename,
  CustomRoleValidation,
  ResolvedCustomRole,
} from "./core/custom-roles.ts";
export { snapshotFor } from "./core/snapshot-for.ts";
export type { SnapshotForOptions } from "./core/snapshot-for.ts";
export type {
  PermDockOptions,
  DecideOptions,
  DeriveOptions,
  PermDock,
  RowPair,
  SimulateOptions,
  WhereResult,
} from "./core/permdock.ts";
export {
  definePermissions,
  findPermission,
  formerKeys,
  getResource,
  isPermission,
  listPermissions,
  mergePermissions,
  resource,
} from "./core/permissions.ts";
export { crud, readable, writable } from "./core/presets.ts";
export type {
  ActionMeta,
  DefinePermissionsOptions,
  MetaValue,
  Permission,
  PermissionKind,
  PermissionTree,
  ResourceInit,
  ResourceLevel,
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
} from "./core/permissions.ts";
export {
  allOf,
  allow,
  anyOf,
  definePolicy,
  deny,
  holder,
  normalizeApproval,
  normalizeAssurance,
  requiresApproval,
  role,
  separationConflicts,
  user,
} from "./core/policy.ts";
export type {
  ActivationOption,
  ApprovalEscalation,
  ApprovalMode,
  ApprovalOption,
  ApprovalRequirement,
  ApprovalStage,
  AnyOfApprover,
  Approver,
  ApproverInput,
  PermissionApprover,
  UserApprover,
  AssuranceRequirement,
  BreakGlassOptions,
  BreakGlassRequirements,
  BreakGlassSpec,
  ClosureContext,
  ClosureGrantFn,
  DelegationInput,
  DelegationTarget,
  PolicyOAuthScope,
  Grant,
  GrantCondition,
  GrantLimit,
  GrantOptions,
  GrantScope,
  GrantValidity,
  HostedGrantRef,
  MembershipFixture,
  Policy,
  PolicyDelegation,
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
} from "./core/policy.ts";
export { breakGlass, supportAccess } from "./core/elevated.ts";
export type { ActivateInput } from "./core/elevated.ts";
export { parseDuration } from "./core/duration.ts";
export {
  actor,
  anyone,
  assurance,
  authenticated,
  plan,
  relation,
} from "./core/grantee.ts";
export type { Grantee, GranteeInput, RelationGrantee } from "./core/grantee.ts";
export type {
  PolicyScopesInput,
  Scope,
  ScopeDeclaration,
  ScopeNames,
} from "./core/scopes.ts";
export {
  definePlans,
  defineRoles,
  findRole,
  isPlan,
  isRole,
  listPlans,
  listRoles,
} from "./core/vocabulary.ts";
export type {
  Plan,
  PlanTree,
  Role,
  RoleMeta,
  RoleTree,
  Vocabulary,
} from "./core/vocabulary.ts";
export type {
  RoleChange,
  RoleChangeDecision,
  RoleChangeOptions,
  RoleChangeTarget,
} from "./core/ownership.ts";
export {
  CLOUD_EVENT_TYPES,
  accessEvent,
  credentialEvent,
  membershipEvent,
  memorySink,
  signDecisionBatch,
  toCloudEvent,
} from "./core/sink.ts";
export type {
  CatalogEventData,
  CatalogFinding,
  CatalogFindingCode,
  CloudEvent,
  CloudEventType,
  MemorySink,
  MemorySinkOptions,
  SignDecisionBatchOptions,
} from "./core/sink.ts";
export { OCSF_VERSION, accessToOcsf, toOcsf } from "./core/ocsf.ts";
export { CSV_COLUMNS, toCsvRow } from "./core/csv.ts";
export { catalogFingerprint } from "./core/catalog-fingerprint.ts";
export {
  coveredByDelegation,
  delegatedPermissions,
} from "./core/delegation.ts";
export {
  capabilitySubject,
  linkPolicyViolation,
  parseCapability,
  signCapability,
} from "./core/capability.ts";
export type {
  Capability,
  CapabilityInput,
  CapabilityRedeemer,
  LinkPolicy,
  LinkPolicyViolation,
  LinkPrincipal,
  SignCapabilityOptions,
} from "./core/capability.ts";
export {
  credentialDelegation,
  credentialPolicyViolation,
  credentialSubject,
  decideCredential,
  parseCredential,
} from "./core/credential.ts";
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
} from "./core/credential.ts";
export type { OcsfAccountChange, OcsfAuthorizeSession } from "./core/ocsf.ts";
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
} from "./core/subject.ts";
export type { ClientNames } from "./core/clients.ts";
