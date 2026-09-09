export { subject } from './conditions/index.ts';
export { opaque } from './conditions/opaque.ts';
export type {
  Condition,
  ConditionRef,
  ConditionValue,
  MemberOfCondition,
} from './conditions/ast.ts';
export { describe } from './core/describe.ts';
export type { DecisionDescription } from './core/describe.ts';
export type {
  ApprovalRequiredDecision,
  Decision,
  Denial,
  DenialReason,
  DeniedDecision,
  GrantedDecision,
  MatchedGrant,
} from './core/decision.ts';
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from './core/errors.ts';
export type { ProblemDetails } from './core/errors.ts';
export { memoryRoleSource } from './core/interfaces.ts';
export { memoryLimitStore } from './core/limits.ts';
export type {
  AuthEvent,
  DecisionEvent,
  DecisionProvider,
  DecisionSink,
  DirectoryEvent,
  LimitConsumeInput,
  LimitRemaining,
  LimitStore,
  SinkEvent,
  MembershipSource,
  RoleSource,
  Snapshot,
  SnapshotGrant,
  SnapshotSource,
  SubjectResolver,
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
  ResourceParent,
} from './core/permissions.ts';
export { allow, definePolicy, deny, role } from './core/policy.ts';
export type {
  ClosureContext,
  ClosureGrantFn,
  Grant,
  GrantCondition,
  GrantOptions,
  Policy,
  PrincipalOf,
  Role,
  RoleOptions,
  SubjectOf,
  ValidateMode,
} from './core/policy.ts';
export { memorySink, signDecisionBatch, toCloudEvent } from './core/sink.ts';
export type {
  CloudEvent,
  CloudEventType,
  MemorySink,
  MemorySinkOptions,
  SignDecisionBatchOptions,
} from './core/sink.ts';
export type {
  Actor,
  Assurance,
  AuthorizationDetail,
  Binding,
  CustomRole,
  Delegation,
  GnapAccess,
  Membership,
  Principal,
  Subject,
} from './core/subject.ts';
