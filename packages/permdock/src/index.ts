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
  RestrictedAncestors,
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
export type { AppData, AppDataSchema } from "./core/app-data.ts";
export type {
  AppObligation,
  ApprovalRequiredDecision,
  Decision,
  Denial,
  DenialDetails,
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
  memoryMembershipSource,
  memoryRoleSource,
  memorySnapshotSource,
  memorySettings,
} from "./core/memory-sources.ts";
export { memoryPrincipalSource } from "./core/principal-source.ts";
export type {
  PrincipalIdentity,
  PrincipalIdentityLink,
  PrincipalSource,
} from "./core/principal-source.ts";
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
  countHolders,
  isExternallyManaged,
} from "./core/memberships.ts";
export { fromStripeEntitlements } from "./core/stripe-entitlements.ts";
export type { StripeEntitlementsClient } from "./core/stripe-entitlements.ts";
export { memoryLimitStore } from "./core/limits.ts";
export { memoryRelations } from "./core/memory-relations.ts";
export type {
  MemoryEdge,
  MemoryRelationsData,
} from "./core/memory-relations.ts";
export type { Holder, HoldingVia, WhoCan } from "./core/who-can.ts";
export {
  isPortableCondition,
  memoryPolicySource,
  mergeHostedGrants,
  parsePolicyDocument,
  policyDocumentFromClaims,
} from "./core/hosted.ts";
export type {
  HostedGrant,
  HostedGrantDropReason,
  HostedGrantDropped,
  PolicyDocument,
  PolicySource,
} from "./core/hosted.ts";
export type {
  CredentialVerifier,
  DecisionProvider,
  DecisionSink,
  LimitConsumeInput,
  LimitRemaining,
  LimitStore,
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
export type {
  LocalCustomRoleTable,
  LocalSnapshotManifest,
  Snapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotNotEntitled,
  SnapshotScope,
} from "./core/snapshot-types.ts";
export type {
  AccessEvent,
  AuthEvent,
  CredentialEvent,
  DecisionEvent,
  DirectoryEvent,
  MembershipEvent,
  SinkEvent,
} from "./core/event-types.ts";
export { arazzoFindings, simulateArazzo } from "./core/arazzo.ts";
export type {
  ArazzoFinding,
  ArazzoPlan,
  ArazzoSimulateInput,
  ArazzoStepResult,
} from "./core/arazzo.ts";
export { emptySnapshot, fromSnapshot } from "./core/from-snapshot.ts";
export { localSnapshotManifest } from "./core/local-manifest.ts";
export { parseLocalSnapshotManifest } from "./core/parse-local-manifest.ts";
export { createPermDock, parseSnapshot } from "./core/permdock.ts";
export { wrapPermDock } from "./core/wrap.ts";
export type { PermDockOverrides, PermDockWrap } from "./core/wrap.ts";
export type { RequestContext } from "./core/request-context.ts";
export { mayAccess } from "./core/may-access.ts";
export { mayUse, permittedIds } from "./core/may-use.ts";
export type { PermittedIdsOptions } from "./core/may-use.ts";
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
export type { InstanceOptions } from "./core/instance-options.ts";
export { snapshotFor } from "./core/snapshot-for.ts";
export type { SnapshotForOptions } from "./core/snapshot-for.ts";
export type {
  PermDockOptions,
  DecideOptions,
  DeriveOptions,
  PermDock,
  RowPair,
  SimulateOptions,
  SnapshotOptions,
  WhereResult,
} from "./core/permdock.ts";
export { definePermissions } from "./core/permissions.ts";
export { defineOperations } from "./core/operations.ts";
export type {
  Operation,
  OperationDefinition,
  OperationEffect,
  OperationInput,
  OperationMap,
  OperationMeta,
  OperationRisk,
} from "./core/operations.ts";
export {
  findPermission,
  getResource,
  isPermission,
  listPermissions,
  mergePermissions,
} from "./core/permission-registry.ts";
export { formerKeys, resource } from "./core/permission-leaf.ts";
export { crud, readable, writable } from "./core/presets.ts";
export type { MetaValue } from "./core/permissions.ts";
export type {
  ActionMeta,
  DefinePermissionsOptions,
  Permission,
  PermissionKind,
  PermissionTree,
  ResourceInit,
  ResourceLevel,
  ResourceMeta,
  ResourceXTree,
  ResourceNode,
  ResourceOptions,
  ComputedRelation,
  EdgeGroup,
  EdgeGroups,
  EdgeMatch,
  EdgeRelation,
  FieldRelation,
  PrincipalRelation,
  ResourceLink,
  ResourceParent,
  ResourceRelation,
  ResourceRelationInput,
  ResourceRestricted,
} from "./core/permission-types.ts";
export type { RESOURCE_X } from "./core/brands.ts";
export {
  allOf,
  anyOf,
  definePolicy,
  holder,
  requiresApproval,
  separationConflicts,
  user,
} from "./core/policy.ts";
export { normalizeAssurance, role } from "./core/role-builder.ts";
export { allow, deny } from "./core/grant-builders.ts";
export { normalizeApproval } from "./core/approval-normalize.ts";
export type {
  AnyOfApprover,
  Approver,
  ApproverInput,
  PermissionApprover,
  UserApprover,
} from "./core/policy.ts";
export type {
  ActivationOption,
  ApprovalEscalation,
  ApprovalMode,
  ApprovalOption,
  ApprovalRequirement,
  ApprovalStage,
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
  GrantMeta,
  GrantOptions,
  GrantScope,
  GrantValidity,
  HostedGrantRef,
  MembershipFixture,
  ObligationInput,
  Policy,
  PolicyAppDataSchemas,
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
} from "./core/policy-types.ts";
export { breakGlass, supportAccess } from "./core/elevated.ts";
export type { ActivateInput } from "./core/elevated.ts";
export { parseDuration } from "./core/duration.ts";
export {
  actor,
  anyone,
  assurance,
  authenticated,
  inherit,
  plan,
  relation,
} from "./core/grantee.ts";
export type {
  Grantee,
  GranteeInput,
  InheritGrantee,
  RelationGrantee,
} from "./core/grantee.ts";
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
  VocabularyOptions,
} from "./core/vocabulary.ts";
export type {
  RoleChange,
  RoleChangeDecision,
  RoleChangeOptions,
  RoleChangeTarget,
} from "./core/ownership.ts";
export {
  CLOUD_EVENT_TYPES,
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  CLOUDEVENTS_CONTENT_TYPE,
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
  CloudEventOptions,
  SignDecisionBatchOptions,
} from "./core/sink.ts";
export { OCSF_VERSION, accessToOcsf, toOcsf } from "./core/ocsf.ts";
export { CSV_COLUMNS, toCsvRow } from "./core/csv.ts";
export { catalogFingerprint } from "./core/catalog-fingerprint.ts";
export {
  parseCloudEventBatch,
  parseSinkEvent,
  parseSinkEvents,
} from "./core/parse-sink-events.ts";
export {
  ACCESS_EVENT_SCHEMA,
  CATALOG_EVENT_SCHEMA,
  CREDENTIAL_EVENT_SCHEMA,
  DECISION_EVENT_SCHEMA,
  DIRECTORY_EVENT_SCHEMA,
  EVENT_SCHEMA_IDS,
  MEMBERSHIP_EVENT_SCHEMA,
  SINK_EVENT_SCHEMAS,
} from "./core/event-schemas.ts";
export type { JsonSchemaNode } from "./core/json-schema.ts";
export {
  coveredByDelegation,
  delegatedPermissions,
} from "./core/delegation.ts";
export {
  capabilityFromClaims,
  capabilitySubject,
  linkPolicyViolation,
  parseCapability,
  parseCapabilityClaim,
  signCapability,
} from "./core/capability.ts";
export type {
  Capability,
  CapabilityClaim,
  CapabilityConfirmation,
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
  isFeedId,
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
