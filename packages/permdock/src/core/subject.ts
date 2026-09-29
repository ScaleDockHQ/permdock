export type JsonWebKeyLike = {
  readonly kty?: string;
  readonly [key: string]: unknown;
};

export type Binding = {
  readonly jkt?: string;
  readonly 'x5t#S256'?: string;
  readonly jwk?: JsonWebKeyLike;
  readonly kid?: string;
};

/**
 * One OpenID Connect for Identity Assurance `verified_claims` entry, kept as
 * the issuer sent it: opaque, frozen evidence for conditions and audit.
 */
export type VerifiedClaims = {
  readonly verification: Readonly<Record<string, unknown>> & {
    readonly trust_framework: string;
  };
  readonly claims: Readonly<Record<string, unknown>>;
};

export type Assurance = {
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly authTime?: number;
  readonly verified?: readonly VerifiedClaims[];
};

export type Membership = {
  readonly tenant?: string;
  readonly team?: string;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  readonly via?: string;
  readonly expiresAt?: number;
};

/**
 * One permission a custom role adds or removes. It names a declared
 * permission key and carries no condition, approval or limit of its own.
 */
export type CustomRoleGrant = {
  readonly permission: string;
  readonly effect?: 'allow' | 'deny';
};

export type CustomRole = {
  readonly tenant: string;
  /** Set for a team-scoped custom role; its ceiling is the assignable team roles. */
  readonly team?: string;
  readonly name: string;
  readonly includes?: readonly string[];
  readonly grants?: readonly CustomRoleGrant[];
  readonly meta?: Readonly<Record<string, unknown>>;
};

export type Principal = {
  readonly id: string;
  readonly issuer?: string;
  readonly kind?: 'user' | 'service' | 'workload';
  readonly roles?: readonly string[];
  readonly plans?: readonly string[];
  readonly memberships?: readonly Membership[];
  readonly tenant?: string;
  readonly assurance?: Assurance;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};

export type Actor = {
  readonly id: string;
  readonly kind: string;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};

export type AuthorizationDetail = {
  readonly type: string;
  readonly actions?: readonly string[];
  readonly [key: string]: unknown;
};

export type GnapAccess = string | Readonly<Record<string, unknown>>;

export type Delegation = {
  readonly scopes?: readonly string[];
  readonly authorizationDetails?: readonly AuthorizationDetail[];
  readonly access?: readonly GnapAccess[];
  readonly chain?: unknown;
};

export type Subject<TPrincipal extends Principal = Principal> = {
  readonly principal: TPrincipal | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};

export function isPrincipal(value: unknown): value is Principal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if ('principal' in value && 'context' in value) {
    return false;
  }
  const record = value as {
    readonly id?: unknown;
    readonly roles?: unknown;
    readonly memberships?: unknown;
    readonly kind?: unknown;
    readonly issuer?: unknown;
  };
  if (typeof record.id !== 'string') {
    return false;
  }
  return (
    Array.isArray(record.roles) ||
    Array.isArray(record.memberships) ||
    record.kind === 'user' ||
    record.kind === 'service' ||
    record.kind === 'workload' ||
    typeof record.issuer === 'string'
  );
}

export function isSubject(value: unknown): value is Subject {
  return (
    value !== null &&
    typeof value === 'object' &&
    'principal' in value &&
    'context' in value &&
    typeof (value as Subject).context === 'object'
  );
}

export function isActor(value: unknown): value is Actor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  return typeof record.id === 'string' && typeof record.kind === 'string';
}

export function anonymousSubject(
  context: Readonly<Record<string, unknown>> = {},
): Subject {
  return Object.freeze({
    principal: null,
    context: Object.freeze({ ...context }),
  });
}
