export { expectTypeOf } from "vitest";
export { describePolicy } from "./describe-policy.ts";
export { policyMatrix, testOrmParity, testRlsParity } from "./core.ts";
export type {
  DescribePolicyConfig,
  MatrixCell,
  MatrixOutcome,
  OrmParityCase,
  OrmParityOptions,
  OrmParityReport,
  OrmParityRunInput,
  OrmParityScenario,
  PolicyMatrixCell,
  PolicyMatrixReport,
  RlsDbOutcome,
  RlsFieldsOutcome,
  RlsParityCase,
  RlsParityFixture,
  RlsParityOptions,
  RlsParityReport,
  RlsParitySubject,
  RlsQueryFn,
  RlsQueryResult,
} from "./core.ts";
export { testClientParity } from "./client-parity.ts";
export { testLegacyParity } from "./legacy-parity.ts";
export type { LegacyParityCase } from "./legacy-parity.ts";
export type { ClientParityCase, ClientParityOptions } from "./client-parity.ts";
export { testClientStore } from "./client-store.ts";
export type {
  ClientStorePermDock,
  ClientStoreFactory,
  ClientStoreFactoryOptions,
  ClientStoreHandle,
  ClientStoreStatus,
} from "./client-store.ts";
export { snapshotFixture } from "./snapshot-fixture.ts";
export { testHttpAdapter } from "./http-adapter/scenarios.ts";
export type {
  HttpAdapterOptions,
  HttpCall,
  HttpMounted,
  HttpOp,
  HttpResult,
  HttpScenarioDomain,
  HttpScenarioName,
} from "./http-adapter/domain.ts";
export {
  AGENT_THROWING_ROW,
  AGENT_THROWING_USER,
  testAgentAdapter,
} from "./agent-adapter.ts";
export type {
  AgentAdapterOptions,
  AgentCall,
  AgentMounted,
  AgentOutcome,
  AgentScenarioDomain,
  AgentScenarioName,
  AgentToolName,
} from "./agent-adapter.ts";
export { testAgentRuntime } from "./agent-runtime.ts";
export type {
  AgentRuntimeContext,
  AgentRuntimeDomain,
  AgentRuntimeModel,
  AgentRuntimeMounted,
  AgentRuntimeOperation,
  AgentRuntimeOptions,
  AgentRuntimeScenarioName,
} from "./agent-runtime.ts";
export {
  authzenTodoData,
  authzenTodoPermissions,
  authzenTodoPolicy,
  authzenTodoUsers,
  authzenTodoVectors,
  testAuthzen,
} from "./authzen.ts";
export type {
  AuthzenEvaluationVector,
  AuthzenEvaluationsVector,
  AuthzenSearchVector,
  AuthzenVectors,
  TestAuthzenOptions,
} from "./authzen.ts";
export { testCloudApi } from "./cloud-api/index.ts";
export type {
  CloudApiKeys,
  TestCloudApiOptions,
  TestCloudPlatformOptions,
} from "./cloud-api/index.ts";
export type { ApprovalStoreOptions } from "./conformance/approvals.ts";
export {
  testAccessReviewStore,
  testApprovalDelegationSource,
  testApprovalPolicySource,
  testApprovalStore,
  testIdempotencyStore,
} from "./conformance/approvals.ts";
export { testWhereCompiler } from "./conformance/where.ts";
export {
  testCredentialVerifier,
  testReplayStore,
  testRevocationFeed,
  testSetQueue,
  testSsfStreamStore,
  testTokenSigner,
  testTokenVerifier,
} from "./conformance/credentials.ts";
export {
  testDecisionSink,
  testLimitStore,
  testPolicySource,
  testSnapshotSource,
} from "./conformance/runtime-stores.ts";
export {
  testDecisionProvider,
  testSnapshotStorage,
} from "./conformance/providers.ts";
export type { DecisionProviderRunnerOptions } from "./conformance/providers.ts";
export { testRelationSource } from "./conformance/relations.ts";
export { testPrincipalSource } from "./conformance/principals.ts";
export {
  testApprovalWaiter,
  testAutomationSource,
  testSupportSessionSource,
} from "./conformance/automations.ts";
export { testDeliveryTransport } from "./delivery-transport.ts";
export type {
  DeliveryFailureKind,
  DeliveryTransportHarness,
  DeliveryTransportOptions,
} from "./delivery-transport.ts";
export {
  testEntitlementSource,
  testDirectoryStore,
  testMembershipSource,
  testCustomRoleSource,
  testSettingsSource,
  testSubjectResolver,
} from "./conformance/identity.ts";
export {
  jwtFixtureAudience,
  jwtFixtureIssuer,
  jwtFixtureJwks,
  jwtFixtureTokens,
} from "./jwt-fixtures.ts";
export {
  supabaseClaimFixtures,
  supabaseClaimVectors,
  supabaseHookManifestFixture,
  supabaseMembershipsBudget,
} from "./supabase-fixtures.ts";
export type {
  SupabaseClaimFixture,
  SupabaseClaimFixtureName,
  SupabaseClaimVectors,
} from "./supabase-fixtures.ts";
export { PROBLEM_EXAMPLES } from "./problem-examples.ts";
