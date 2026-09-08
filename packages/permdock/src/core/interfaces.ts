import type { Condition } from '../conditions/ast.ts';
import type {
  CustomRole,
  JsonWebKeyLike,
  Membership,
  Principal,
  Subject,
} from './subject.ts';

export type RoleSource = {
  rolesFor(tenant: string): CustomRole[] | Promise<CustomRole[]>;
  assignable?(tenant: string): string[] | Promise<string[]>;
};

export type MembershipSource = {
  membershipsFor(
    principal: { readonly id: string; readonly kind?: string },
    options: { readonly tenant?: string },
  ): Membership[] | Promise<Membership[]>;
};

export type JwtClaims = {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [key: string]: unknown;
};

export type TokenFailureCause =
  | 'invalid-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-audience'
  | 'wrong-issuer'
  | 'wrong-token-type'
  | 'alg-not-allowed'
  | 'alg-none'
  | 'unknown-kid'
  | 'malformed'
  | 'encrypted-token'
  | 'dpop-proof-invalid'
  | 'mtls-binding-mismatch'
  | 'sender-constraint-required'
  | 'token-in-query'
  | 'invalid-claims'
  | 'jwks-unavailable'
  | 'discovery-unavailable'
  | 'discovery-mismatch';

export type VerifiedToken<TClaims extends JwtClaims = JwtClaims> = {
  readonly ok: true;
  readonly claims: TClaims;
  readonly header: {
    readonly alg: string;
    readonly kid?: string;
    readonly typ?: string;
  };
};

export type VerificationFailure = {
  readonly ok: false;
  readonly reason: 'invalid-token';
  readonly cause: TokenFailureCause;
};

export type TokenVerifier<TClaims extends JwtClaims = JwtClaims> = {
  verify(
    token: string,
    expectations: {
      readonly typ?: string | readonly string[];
      readonly audience?: string | readonly string[];
      readonly issuer?: string;
      readonly clockTolerance?: number;
    },
  ): Promise<VerifiedToken<TClaims> | VerificationFailure>;
};

export type TokenSigner = {
  sign(
    payload: Readonly<Record<string, unknown>>,
    options: {
      readonly typ:
        | 'permdock-snapshot+jwt'
        | 'permdock-approval+jwt'
        | 'permdock-decisions+jwt';
      readonly audience?: string | readonly string[];
      readonly expiresAt?: number;
    },
  ): Promise<string>;
  readonly kid?: string;
  jwks?(): Promise<{ readonly keys: readonly JsonWebKeyLike[] }>;
};

export type SubjectResolver<
  TInput,
  TPrincipal extends Principal = Principal,
> = (
  input: TInput,
  options?: { readonly tenant?: string },
) => Subject<TPrincipal> | Promise<Subject<TPrincipal>>;

export type SnapshotV2 = {
  readonly v: 1 | 2;
  readonly issuedAt: number;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
      readonly memberships?: readonly Membership[];
    } | null;
    readonly delegation?: Subject['delegation'];
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly roles: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly tenants: readonly string[];
  readonly include?: readonly string[];
  readonly simulated?: true;
  readonly expiresAt?: number;
};

export type SnapshotGrant = {
  readonly permission: string;
  readonly effect: 'allow' | 'deny';
  readonly role: string;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human';
  readonly scope?: 'tenant' | 'team' | { readonly resource: string };
  readonly membership?: Membership;
  readonly portable?: false;
};

export type SnapshotSource = {
  get(): Promise<SnapshotV2 | string> | SnapshotV2 | string;
  subscribe?(listener: () => void): () => void;
};

export type PortableCondition = Condition;

export type WhereCompiler<TTarget, TOptions = unknown> = (
  condition: PortableCondition,
  target: TTarget,
  options?: TOptions,
) => unknown;

export type LimitStore = {
  consume(input: {
    readonly key: string;
    readonly subjectId: string;
    readonly count: number;
    readonly per: string;
  }): Promise<{ readonly remaining: number }> | { readonly remaining: number };
};

export type DecisionSink = {
  write(events: readonly DecisionEvent[]): Promise<void> | void;
  flush?(): Promise<void>;
};

export type DecisionEvent = {
  readonly type: 'decision';
  readonly at: string;
  readonly outcome: 'granted' | 'denied' | 'approval-required';
  readonly permission: string;
  readonly scope: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
    } | null;
    readonly actor?: { readonly id: string; readonly kind: string };
    readonly delegation?: {
      readonly scopes?: readonly string[];
      readonly authorizationDetails?: readonly unknown[];
    };
  };
  readonly tenant?: string;
  readonly membership?: Membership;
  readonly via?: string | null;
  readonly matched?: { readonly role: string; readonly permission: string };
  readonly denials?: readonly {
    readonly role: string | null;
    readonly reason: string;
  }[];
  readonly alternatives?: readonly string[];
  readonly token?: string;
  readonly trusted: boolean;
  readonly source:
    | 'can'
    | 'decide'
    | 'assert'
    | 'filter'
    | 'endpoint'
    | 'adapter'
    | 'approval'
    | 'simulate';
  readonly adapter?: string;
  readonly phase?: 'requested' | 'resolved';
  readonly counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  };
};

export type AuthEvent = {
  readonly reason:
    | 'invalid-token'
    | 'schema'
    | 'unknown-role'
    | 'groups-overflow'
    | 'source-threw';
  readonly cause?: string;
  readonly source: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly typ?: string;
  readonly issuer?: string;
  readonly requestId?: string;
};

export function memoryRoleSource(
  customRoles: readonly CustomRole[],
): RoleSource {
  const byTenant = new Map<string, CustomRole[]>();
  for (const role of customRoles) {
    const list = byTenant.get(role.tenant) ?? [];
    list.push(role);
    byTenant.set(role.tenant, list);
  }
  return {
    rolesFor(tenant: string): CustomRole[] {
      return byTenant.get(tenant) ?? [];
    },
  };
}
