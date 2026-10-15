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
  memoryCustomRoleSource,
  memorySnapshotSource,
  memorySettingsSource,
} from "./core/memory-sources.ts";
export { memoryPrincipalSource } from "./core/principal-source.ts";
export type {
  PrincipalIdentity,
  PrincipalIdentityLink,
  PrincipalSource,
} from "./core/principal-source.ts";
export {
  decideAutomation,
  memoryAutomationSource,
  parseAutomation,
} from "./core/automation.ts";
export type {
  Automation,
  AutomationDecision,
  AutomationMode,
  AutomationRequest,
  AutomationSource,
  DecideAutomationOptions,
  MemoryAutomationSource,
} from "./core/automation.ts";
export {
  decideSupportSession,
  parseSupportSession,
} from "./core/support-session.ts";
export type {
  DecideSupportSessionOptions,
  SupportSession,
  SupportSessionDecision,
  SupportSessionPolicy,
  SupportSessionRequest,
} from "./core/support-session.ts";
export {
  approvalPolicies,
  memoryApprovalPolicySource,
  validateApprovalPolicy,
} from "./core/approval-policies.ts";
export { APPROVAL_POLICY_UNAVAILABLE } from "./core/approval-state.ts";
export type {
  ApprovalPolicies,
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
export { stripeEntitlementSource } from "./core/stripe-entitlements.ts";
export type { StripeEntitlementsClient } from "./core/stripe-entitlements.ts";
export { limits, memoryLimitStore } from "./core/limits.ts";
export type { Limits } from "./core/limits.ts";
export { memoryRelationSource } from "./core/memory-relations.ts";
export type {
  MemoryEdge,
  MemoryRelationSourceData,
} from "./core/memory-relations.ts";
export { whoCan } from "./core/who-can.ts";
export type { Holder, HoldingVia, WhoCan } from "./core/who-can.ts";
export {
  isPortableCondition,
  memoryPolicySource,
  hostedPolicies,
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
  CustomRoleSource,
  CustomRoleSourceFactory,
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
  AutomationEvent,
  CredentialEvent,
  DecisionEvent,
  DeliveryChannel,
  DeliveryEvent,
  DeliveryFailureCause,
  DirectoryEvent,
  EmailCategory,
  MembershipEvent,
  SinkEvent,
} from "./core/event-types.ts";
export { deliveryEvent } from "./core/delivery-event.ts";
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
export { defineApp } from "./core/app.ts";
export type { AppOptions, AppProfile } from "./core/app.ts";
export { wrapPermDock } from "./core/wrap.ts";
export { shadowMode } from "./core/shadow.ts";
export type {
  LegacyCheck,
  ShadowMismatch,
  ShadowOptions,
} from "./core/shadow.ts";
export type { PermDockOverrides, PermDockWrap } from "./core/wrap.ts";
export type { RequestContext } from "./core/request-context.ts";
export { mayAccess } from "./core/may-access.ts";
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
export { OPERATION_RISKS, isOperationRisk } from "./core/operation-risks.ts";
export type { OperationRisk } from "./core/operation-risks.ts";
export { defineOperations } from "./core/operations.ts";
export type {
  Operation,
  OperationData,
  OperationDefinition,
  OperationEffect,
  OperationInput,
  OperationMap,
  OperationMeta,
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
  WireValidity,
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
export { activate, breakGlass, supportAccess } from "./core/elevated.ts";
export type { ActivateInput } from "./core/elevated.ts";
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
export { decideRoleChange } from "./core/ownership.ts";
export type {
  RoleChange,
  RoleChangeDecision,
  RoleChangeOptions,
  RoleChangeTarget,
} from "./core/ownership.ts";
export {
  CLOUDEVENTS_BATCH_CONTENT_TYPE,
  CLOUDEVENTS_CONTENT_TYPE,
  CLOUD_EVENT_TYPES,
  RESERVED_CLOUD_EVENT_TYPES,
  accessEvent,
  automationEvent,
  cloudEventType,
  credentialEvent,
  membershipEvent,
  memoryDecisionSink,
  signDecisionBatch,
  supportSessionEvent,
  toCloudEvent,
} from "./core/sink.ts";
export type {
  CatalogEventData,
  CatalogFinding,
  CatalogFindingCode,
  CloudEvent,
  CloudEventOptions,
  CloudEventType,
  MemoryDecisionSink,
  MemoryDecisionSinkOptions,
  SignDecisionBatchOptions,
} from "./core/sink.ts";
export {
  parseCatalogEventData,
  parseCloudEvent,
  parseCloudEventBatch,
  parseSinkEvent,
  parseSinkEvents,
} from "./core/parse-sink-events.ts";
export {
  ACCESS_EVENT_SCHEMA,
  AUTOMATION_EVENT_SCHEMA,
  CATALOG_EVENT_SCHEMA,
  CREDENTIAL_EVENT_SCHEMA,
  DECISION_EVENT_SCHEMA,
  DELIVERY_EVENT_SCHEMA,
  DIRECTORY_EVENT_SCHEMA,
  EVENT_SCHEMA_IDS,
  MEMBERSHIP_EVENT_SCHEMA,
  SINK_EVENT_SCHEMAS,
} from "./core/event-schemas.ts";
export type { JsonSchemaNode } from "./core/json-schema.ts";
export { OCSF_VERSION, accessToOcsf, toOcsf } from "./core/ocsf.ts";
export { CSV_COLUMNS, toCsvRow } from "./core/csv.ts";
export { catalogFingerprint } from "./core/catalog-fingerprint.ts";
export {
  coveredByDelegation,
  delegatedPermissions,
} from "./core/delegation.ts";
export {
  capabilityFromClaims,
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
  CapabilityPrincipal,
  CapabilityRedeemer,
  LinkPolicy,
  LinkPolicyViolation,
  SignCapabilityOptions,
} from "./core/capability.ts";
export {
  credentialDelegation,
  credentialPolicyViolation,
  decideCredential,
  isFeedId,
  parseCredential,
} from "./core/credential.ts";
export type {
  ApiKeyPrincipal,
  Credential,
  CredentialDecision,
  CredentialKind,
  CredentialPermission,
  CredentialPermissionInput,
  CredentialPolicy,
  CredentialPolicyViolation,
  CredentialRequest,
  DecideCredentialOptions,
} from "./core/credential.ts";
export type { OcsfAuthorizeSession, OcsfUserManagement } from "./core/ocsf.ts";
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
