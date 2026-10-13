export { expectTypeOf } from "vitest";
export { describePolicy } from "./describe-policy.ts";
export { rlsParity } from "./rls-parity.ts";
export { ormParity } from "./orm-parity.ts";
export type {
  OrmParityCase,
  OrmParityOptions,
  OrmParityReport,
  OrmParityRunInput,
  OrmParityScenario,
} from "./orm-parity.ts";
export { testClientParity } from "./client-parity.ts";
export type { ClientParityCase, ClientParityOptions } from "./client-parity.ts";
export { testClientStore } from "./client-store.ts";
export type {
  ClientStorePermDock,
  ClientStoreFactory,
  ClientStoreFactoryOptions,
  ClientStoreHandle,
  ClientStoreStatus,
} from "./client-store.ts";
export type {
  RlsDbOutcome,
  RlsFieldsOutcome,
  RlsParityCase,
  RlsParityFixture,
  RlsParityOptions,
  RlsParityReport,
  RlsParitySubject,
  RlsQueryFn,
  RlsQueryResult,
} from "./rls-parity.ts";
export type {
  DescribePolicyConfig,
  MatrixCell,
  MatrixOutcome,
} from "./describe-policy.ts";
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
export {
  authzenTodoData,
  authzenTodoPermissions,
  authzenTodoPolicy,
  authzenTodoUsers,
  authzenTodoVectors,
  testAuthZen,
} from "./authzen.ts";
export type {
  AuthZenEvaluationVector,
  AuthZenEvaluationsVector,
  AuthZenSearchVector,
  AuthZenVectors,
  TestAuthZenOptions,
} from "./authzen.ts";
export type { ApprovalStoreOptions } from "./conformance/approvals.ts";
export {
  testAccessReviewStore,
  testApprovalDelegationSource,
  testApprovalPolicySource,
  testApprovalStore,
} from "./conformance/approvals.ts";
export { testWhereCompiler } from "./conformance/where.ts";
export {
  testCredentialVerifier,
  testReplayStore,
  testRevocationFeed,
  testTokenSigner,
  testTokenVerifier,
} from "./conformance/credentials.ts";
export {
  testDecisionSink,
  testLimitStore,
  testPolicySource,
  testSnapshotSource,
} from "./conformance/runtime-stores.ts";
export { testRelationSource } from "./conformance/relations.ts";
export { testPrincipalSource } from "./conformance/principals.ts";
export {
  testEntitlementSource,
  testDirectoryStore,
  testMembershipSource,
  testRoleSource,
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
