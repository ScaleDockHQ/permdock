import { expectTypeOf } from "vitest";
import { DecisionSink, Membership, MembershipSource, Permission, Policy, RoleSource, SnapshotSource, SnapshotV2, SubjectResolver, WhereCompiler } from "permdock";
//#region src/describe-policy.d.ts
type MatrixOutcome = "granted" | "denied" | "approval-required";
type MatrixCell = MatrixOutcome | {
  readonly outcome?: MatrixOutcome;
  readonly denials?: readonly {
    readonly role?: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
};
type DescribePolicyConfig<TSubject> = {
  readonly subjects: Record<string, TSubject>;
  readonly fixtures?: Record<string, unknown>;
  readonly matrix: Record<string, Record<string, MatrixCell | Record<string, MatrixCell>>>;
  readonly exhaustive?: boolean;
};
export declare function describePolicy<TSubject>(policy: Policy, config: DescribePolicyConfig<TSubject>): void;
//#endregion
//#region src/snapshot-fixture.d.ts
export declare function snapshotFixture(policy: Policy, subject: unknown, options?: {
  readonly include?: readonly (Permission | {
    readonly [key: string]: unknown;
  })[];
  readonly tenants?: "all";
  readonly tenant?: string;
  readonly simulated?: boolean;
}): Promise<SnapshotV2>;
//#endregion
//#region src/conformance.d.ts
export declare function testSubjectResolver<TInput>(resolver: SubjectResolver<TInput>, options: {
  readonly invalid: TInput;
}): void;
export declare function testMembershipSource(source: MembershipSource, options: {
  readonly principals: readonly {
    readonly id: string;
    readonly kind?: string;
  }[];
  readonly expect?: Record<string, readonly Membership[]>;
}): void;
export declare function testRoleSource(source: RoleSource, options: {
  readonly tenant: string;
  readonly declared: readonly string[];
}): void;
export declare function testDecisionSink(sink: DecisionSink): void;
export declare function testSnapshotSource(source: SnapshotSource): void;
export declare function testWhereCompiler<TTarget>(compiler: WhereCompiler<TTarget>, options: {
  readonly target: TTarget;
}): void;
//#endregion
export { type DescribePolicyConfig, type MatrixCell, type MatrixOutcome, expectTypeOf };