import type { Condition } from '../conditions/ast.ts';
import type { Decision } from './decision.ts';
import type { Grantee } from './grantee.ts';
import type { Permission } from './permissions.ts';
import type { ApprovalRequirement, HostedGrantRef } from './policy.ts';
import type {
  CustomRole,
  JsonWebKeyLike,
  Membership,
  Principal,
  Subject,
} from './subject.ts';
import type { Plan, Role } from './vocabulary.ts';

export type DecisionProvider = {
  readonly name: string;
  handles(permission: Permission): boolean;
  decide(request: {
    readonly permission: Permission;
    readonly data?: unknown;
    readonly subject: Subject;
    readonly local: Decision;
  }): Promise<Decision>;
  /**
   * Ids of the resources of `permission.resource` the subject may act on.
   * `null` means the provider could not answer and every row is denied;
   * `undefined` means it cannot list, and each row is decided on its own.
   */
  permitted?(request: {
    readonly permission: Permission;
    readonly subject: Subject;
  }): Promise<readonly string[] | null | undefined>;
};

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
  | 'invalid-chain'
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
        | 'permdock-decisions+jwt'
        | 'permdock-policy+jwt';
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

export type Snapshot = {
  readonly v: 1;
  readonly issuedAt: number;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly plans?: readonly string[];
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
  readonly vocabulary?: {
    readonly roles?: Readonly<Record<string, Role>>;
    readonly plans?: Readonly<Record<string, Plan>>;
  };
  /** The policy's row keys, so a client checks the row's tenant and team. */
  readonly scopes?: {
    readonly tenant?: { readonly key: string };
    readonly team?: { readonly key: string };
    /** Row fields that partition each resource, from its `memberOf` relations. */
    readonly partitioned?: Readonly<
      Record<string, { readonly tenant?: true; readonly team?: true }>
    >;
  };
};

export type SnapshotGrant = {
  readonly permission: string;
  readonly effect: 'allow' | 'deny';
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human' | ApprovalRequirement;
  readonly scope?: 'tenant' | 'team' | { readonly resource: string };
  readonly membership?: Membership;
  readonly portable?: false;
  readonly fields?: readonly string[];
};

export type SnapshotSource = {
  get(): Promise<Snapshot | string> | Snapshot | string;
  subscribe?(listener: () => void): () => void;
};

export type WhereCompiler<TTarget, TOptions = unknown> = (
  condition: Condition,
  target: TTarget,
  options?: TOptions,
) => unknown;

export type LimitConsumeInput = {
  readonly key: string;
  readonly subjectId: string;
  readonly count: number;
  readonly per: string;
  readonly now?: number;
  /** The active tenant; a quota counts per subject and tenant. */
  readonly tenant?: string;
};

export type LimitRemaining = {
  readonly remaining: number;
};

export type LimitStore = {
  consume(input: LimitConsumeInput): Promise<LimitRemaining> | LimitRemaining;
  remaining(input: LimitConsumeInput): LimitRemaining | undefined;
};

export type DecisionSink = {
  write(events: readonly SinkEvent[]): Promise<void> | void;
  flush?(): Promise<void>;
};

export type DirectoryEvent = {
  readonly type: 'directory';
  readonly at: string;
  readonly source: 'scim';
  readonly operation: 'create' | 'replace' | 'patch' | 'delete';
  readonly tenant: string;
  readonly resource: {
    readonly type: 'User' | 'Group';
    readonly id: string;
  };
  readonly credential:
    | { readonly kind: 'token' }
    | { readonly kind: 'jwt'; readonly iss?: string };
  readonly active?: boolean;
};

export type MembershipEvent = {
  readonly type: 'membership';
  readonly at: string;
  readonly source: string;
  readonly operation: 'added' | 'removed' | 'changed';
  readonly principal: { readonly id: string };
  readonly tenant?: string;
  readonly team?: string;
  readonly via?: string;
  readonly roles: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  readonly by?: { readonly id: string; readonly kind: string };
};

export type SinkEvent = DecisionEvent | DirectoryEvent | MembershipEvent;

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
  readonly matched?: {
    readonly role: string | null;
    readonly permission: string;
    readonly to?: Grantee | readonly Grantee[];
    readonly hosted?: HostedGrantRef;
  };
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
