import { expectTypeOf } from "vitest";
import { DecisionSink, Membership, MembershipSource, Permission, Policy, RoleSource, SnapshotSource, SnapshotV2, SubjectResolver, TokenSigner, TokenVerifier, WhereCompiler } from "permdock";
import { DirectoryStore } from "permdock/scim";
import { ApprovalStore } from "permdock/approvals";
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
export declare function testDirectoryStore(store: DirectoryStore, options: {
  readonly tenants: readonly [string, string];
}): void;
export declare function testApprovalStore(store: ApprovalStore): void;
export declare function testTokenVerifier(verifier: TokenVerifier, options?: {
  readonly audience?: string;
  readonly issuer?: string;
}): void;
export declare function testTokenSigner(signer: TokenSigner, options: {
  readonly verifier: TokenVerifier;
}): void;
export declare function testWhereCompiler<TTarget>(compiler: WhereCompiler<TTarget>, options: {
  readonly target: TTarget;
  readonly isFailClosed?: (compiled: unknown) => boolean;
}): void;
//#endregion
//#region src/jwt-fixtures.d.ts
export declare const jwtFixtureJwks: {
  readonly keys: readonly [{
    readonly crv: "Ed25519";
    readonly x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ";
    readonly kty: "OKP";
    readonly kid: "2026-09";
    readonly alg: "Ed25519";
    readonly use: "sig";
  }];
};
export declare const jwtFixtureIssuer: "https://login.example.com";
export declare const jwtFixtureAudience: "https://api.example.com";
export declare const jwtFixtureTokens: {
  readonly valid: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJjbGllbnRfaWQiOiJhcHAiLCJyb2xlcyI6WyJtZW1iZXIiXSwianRpIjoianRpLXZhbGlkIiwiaXNzIjoiaHR0cHM6Ly9sb2dpbi5leGFtcGxlLmNvbSIsImF1ZCI6Imh0dHBzOi8vYXBpLmV4YW1wbGUuY29tIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.ENFMmLSyVde-2s4Gdz4iP7srZvU0Xuy_ZLz-OJGHD_-W1lEayEBeSPTnab0L_TBdj8p5BmkFrT-7VE7o20GbAw";
  readonly expired: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJpYXQiOjEwMDAwMDAwMDAsImV4cCI6MTEwMDAwMDAwMH0.9X3d6kH3_2nmrbqMxuoxzFW-wsWJVCe-lR-aQ-MmsGGXlEUBMgQ-4MtAq1UR9lLE0h2b5JrE_GfjzuC04h5xCg";
  readonly wrongAud: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9vdGhlci5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.PgWdzi56J31OwoMqH4ysHzVKSKUDhi-AtHFUp1ewFzi-qGE-tknzrNKnKhDOncVzj0okb_flyy3vQgfzJwG5AQ";
  readonly wrongIss: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2V2aWwuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.tIcLHLa9JLtKz1gqjRGdr5DFbUzRDs5KsoPsJCxspvbBcsFfRFG2G0XJnd1h4QHyZ_5B4OhY3W_jIIsnOPD9Bg";
  readonly unknownKid: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoibm9wZSIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.walgG5GvpCVBnkMtkdw-epi5c93JqfvAM_N4EWR9Tqhiw_cnzITnlQyoVfihECmV1fqtFrhwM1RCIRJvd38zAQ";
  readonly none: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1XzEiLCJpc3MiOiJodHRwczovL2xvZ2luLmV4YW1wbGUuY29tIiwiYXVkIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20iLCJleHAiOjIwMDAwMDAwMDAsImlhdCI6MTcwMDAwMDAwMH0.";
  readonly snapshot: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLXNuYXBzaG90K2p3dCJ9.eyJzbmFwc2hvdCI6eyJ2IjoyLCJpc3N1ZWRBdCI6MTcwMDAwMDAwMCwic3ViamVjdCI6eyJwcmluY2lwYWwiOnsiaWQiOiJ1XzEiLCJyb2xlcyI6WyJtZW1iZXIiXX0sImNvbnRleHQiOnt9fSwicm9sZXMiOlsibWVtYmVyIl0sImdyYW50cyI6W10sInRlbmFudHMiOltdfSwic3ViIjoidV8xIiwiaXNzIjoiaHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJzbmFwX2ZpeHR1cmUifQ.4itaYctluoCwU-syytUxArtS_FRyNAti2SZxuSH-nKIMr7-Sb3h1Q3xugn_vPR1eupV4fVNIe6dH27_EiyDvCA";
  readonly approval: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLWFwcHJvdmFsK2p3dCJ9.eyJhcHByb3ZhbCI6eyJ0b2tlbiI6InBkMS5hYmMiLCJwZXJtaXNzaW9uIjoicG9zdC5kZWxldGUiLCJyZXNvdXJjZSI6eyJ0eXBlIjoicG9zdCIsImlkIjoiNDIifSwic3RhdHVzIjoiYXBwcm92ZWQifSwic3ViIjoidV8xIiwiaXNzIjoiaHR0cHM6Ly9hcHAuZXhhbXBsZS5jb20iLCJhdWQiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJhcHJfZml4dHVyZSJ9.UHsoSzQCo68G7ee-EFqdzMLvmqaKlFIMdQKFuqZEM4yUQnJsJJTXbld_aCXcyfN-IdjF9cj2F5EHzsV4nLKbBg";
  readonly decisions: "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoiMjAyNi0wOSIsInR5cCI6InBlcm1kb2NrLWRlY2lzaW9ucytqd3QifQ.eyJldmVudHMiOltdLCJpc3MiOiJodHRwczovL2FwcC5leGFtcGxlLmNvbSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwLCJqdGkiOiJkZWNfZml4dHVyZSJ9.UZhJd72yFGxHOdjYbzcGYUPgYjvLwOPCtHKxEbLu56SdKSKUDCREXmEBI9WaCPKWjlTBnnIKMYwjG8I8RATJCg";
};
//#endregion
export { type DescribePolicyConfig, type MatrixCell, type MatrixOutcome, expectTypeOf };