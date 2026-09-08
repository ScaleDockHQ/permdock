import { g as Subject, h as Principal, m as Membership, p as JsonWebKeyLike, t as Condition, u as CustomRole } from "./ast-BtUySn6K.js";
//#region src/core/interfaces.d.ts
type RoleSource = {
  rolesFor(tenant: string): CustomRole[] | Promise<CustomRole[]>;
  assignable?(tenant: string): string[] | Promise<string[]>;
};
type MembershipSource = {
  membershipsFor(principal: {
    readonly id: string;
    readonly kind?: string;
  }, options: {
    readonly tenant?: string;
  }): Membership[] | Promise<Membership[]>;
};
type JwtClaims = {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [key: string]: unknown;
};
type TokenFailureCause = "invalid-signature" | "expired" | "not-yet-valid" | "wrong-audience" | "wrong-issuer" | "wrong-token-type" | "alg-not-allowed" | "alg-none" | "unknown-kid" | "malformed" | "encrypted-token" | "dpop-proof-invalid" | "mtls-binding-mismatch" | "sender-constraint-required" | "token-in-query" | "invalid-claims" | "jwks-unavailable" | "discovery-unavailable" | "discovery-mismatch";
type VerifiedToken<TClaims extends JwtClaims = JwtClaims> = {
  readonly ok: true;
  readonly claims: TClaims;
  readonly header: {
    readonly alg: string;
    readonly kid?: string;
    readonly typ?: string;
  };
};
type VerificationFailure = {
  readonly ok: false;
  readonly reason: "invalid-token";
  readonly cause: TokenFailureCause;
};
type TokenVerifier<TClaims extends JwtClaims = JwtClaims> = {
  verify(token: string, expectations: {
    readonly typ?: string | readonly string[];
    readonly audience?: string | readonly string[];
    readonly issuer?: string;
    readonly clockTolerance?: number;
  }): Promise<VerifiedToken<TClaims> | VerificationFailure>;
};
type TokenSigner = {
  sign(payload: Readonly<Record<string, unknown>>, options: {
    readonly typ: "permdock-snapshot+jwt" | "permdock-approval+jwt" | "permdock-decisions+jwt";
    readonly audience?: string | readonly string[];
    readonly expiresAt?: number;
  }): Promise<string>;
  readonly kid?: string;
  jwks?(): Promise<{
    readonly keys: readonly JsonWebKeyLike[];
  }>;
};
type SubjectResolver<TInput, TPrincipal extends Principal = Principal> = (input: TInput, options?: {
  readonly tenant?: string;
}) => Subject<TPrincipal> | Promise<Subject<TPrincipal>>;
type SnapshotV2 = {
  readonly v: 1 | 2;
  readonly issuedAt: number;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
      readonly memberships?: readonly Membership[];
    } | null;
    readonly delegation?: Subject["delegation"];
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly roles: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly tenants: readonly string[];
  readonly include?: readonly string[];
  readonly simulated?: true;
  readonly expiresAt?: number;
};
type SnapshotGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human";
  readonly scope?: "tenant" | "team" | {
    readonly resource: string;
  };
  readonly membership?: Membership;
  readonly portable?: false;
};
type SnapshotSource = {
  get(): Promise<SnapshotV2 | string> | SnapshotV2 | string;
  subscribe?(listener: () => void): () => void;
};
type PortableCondition = Condition;
type WhereCompiler<TTarget, TOptions = unknown> = (condition: PortableCondition, target: TTarget, options?: TOptions) => unknown;
type LimitStore = {
  consume(input: {
    readonly key: string;
    readonly subjectId: string;
    readonly count: number;
    readonly per: string;
  }): Promise<{
    readonly remaining: number;
  }> | {
    readonly remaining: number;
  };
};
type DecisionSink = {
  write(events: readonly SinkEvent[]): Promise<void> | void;
  flush?(): Promise<void>;
};
type DirectoryEvent = {
  readonly type: "directory";
  readonly at: string;
  readonly source: "scim";
  readonly operation: "create" | "replace" | "patch" | "delete";
  readonly tenant: string;
  readonly resource: {
    readonly type: "User" | "Group";
    readonly id: string;
  };
  readonly credential: {
    readonly kind: "token";
  } | {
    readonly kind: "jwt";
    readonly iss?: string;
  };
  readonly active?: boolean;
};
type SinkEvent = DecisionEvent | DirectoryEvent;
type DecisionEvent = {
  readonly type: "decision";
  readonly at: string;
  readonly outcome: "granted" | "denied" | "approval-required";
  readonly permission: string;
  readonly scope: string;
  readonly resource: {
    readonly type: string;
    readonly id?: string;
  };
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
    } | null;
    readonly actor?: {
      readonly id: string;
      readonly kind: string;
    };
    readonly delegation?: {
      readonly scopes?: readonly string[];
      readonly authorizationDetails?: readonly unknown[];
    };
  };
  readonly tenant?: string;
  readonly membership?: Membership;
  readonly via?: string | null;
  readonly matched?: {
    readonly role: string;
    readonly permission: string;
  };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly token?: string;
  readonly trusted: boolean;
  readonly source: "can" | "decide" | "assert" | "filter" | "endpoint" | "adapter" | "approval" | "simulate";
  readonly adapter?: string;
  readonly phase?: "requested" | "resolved";
  readonly counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  };
};
type AuthEvent = {
  readonly reason: "invalid-token" | "schema" | "unknown-role" | "groups-overflow" | "source-threw";
  readonly cause?: string;
  readonly source: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly typ?: string;
  readonly issuer?: string;
  readonly requestId?: string;
};
declare function memoryRoleSource(customRoles: readonly CustomRole[]): RoleSource;
//#endregion
export { VerificationFailure as _, JwtClaims as a, memoryRoleSource as b, RoleSource as c, SnapshotSource as d, SnapshotV2 as f, TokenVerifier as g, TokenSigner as h, DirectoryEvent as i, SinkEvent as l, TokenFailureCause as m, DecisionEvent as n, LimitStore as o, SubjectResolver as p, DecisionSink as r, MembershipSource as s, AuthEvent as t, SnapshotGrant as u, VerifiedToken as v, WhereCompiler as y };