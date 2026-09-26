export { expectTypeOf } from 'vitest';
export { describePolicy } from './describe-policy.ts';
export { rlsParity } from './rls-parity.ts';
export { ormParity } from './orm-parity.ts';
export type {
  OrmParityCase,
  OrmParityOptions,
  OrmParityReport,
  OrmParityRunInput,
  OrmParityScenario,
} from './orm-parity.ts';
export { testClientParity } from './client-parity.ts';
export type { ClientParityCase, ClientParityOptions } from './client-parity.ts';
export { testClientStore } from './client-store.ts';
export type {
  ClientStoreDock,
  ClientStoreFactory,
  ClientStoreFactoryOptions,
  ClientStoreHandle,
  ClientStoreStatus,
} from './client-store.ts';
export type {
  RlsDbOutcome,
  RlsParityCase,
  RlsParityFixture,
  RlsParityOptions,
  RlsParityReport,
  RlsParitySubject,
  RlsQueryFn,
  RlsQueryResult,
} from './rls-parity.ts';
export type {
  DescribePolicyConfig,
  MatrixCell,
  MatrixOutcome,
} from './describe-policy.ts';
export { snapshotFixture } from './snapshot-fixture.ts';
export { testHttpAdapter } from './http-adapter.ts';
export type {
  HttpAdapterOptions,
  HttpCall,
  HttpMounted,
  HttpOp,
  HttpResult,
  HttpScenarioDomain,
  HttpScenarioName,
} from './http-adapter.ts';
export type { ApprovalStoreOptions } from './conformance.ts';
export {
  testApprovalStore,
  testDecisionSink,
  testLimitStore,
  testDirectoryStore,
  testReplayStore,
  testRevocationFeed,
  testMembershipSource,
  testRoleSource,
  testSnapshotSource,
  testSubjectResolver,
  testTokenSigner,
  testTokenVerifier,
  testWhereCompiler,
} from './conformance.ts';
export {
  jwtFixtureAudience,
  jwtFixtureIssuer,
  jwtFixtureJwks,
  jwtFixtureTokens,
} from './jwt-fixtures.ts';
export {
  supabaseClaimFixtures,
  supabaseMembershipsBudget,
} from './supabase-fixtures.ts';
export type {
  SupabaseClaimFixture,
  SupabaseClaimFixtureName,
} from './supabase-fixtures.ts';
