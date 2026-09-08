export { expectTypeOf } from 'vitest';
export { describePolicy } from './describe-policy.ts';
export type {
  DescribePolicyConfig,
  MatrixCell,
  MatrixOutcome,
} from './describe-policy.ts';
export { snapshotFixture } from './snapshot-fixture.ts';
export {
  testDecisionSink,
  testMembershipSource,
  testRoleSource,
  testSnapshotSource,
  testSubjectResolver,
  testWhereCompiler,
} from './conformance.ts';
