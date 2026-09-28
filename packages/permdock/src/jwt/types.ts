import type { StandardSchemaV1 } from '@standard-schema/spec';

import type {
  AuthEvent,
  JwtClaims,
  MembershipSource,
  TokenFailureCause,
  TokenVerifier,
} from '../core/interfaces.ts';
import type { Actor, Principal, Subject } from '../core/subject.ts';

export type JwtAlgorithm =
  | 'ES256'
  | 'PS256'
  | 'Ed25519'
  | 'RS256'
  | 'HS256'
  | 'EdDSA';

export type JwtProfile = 'fapi2';

export type JsonWebKeySet = {
  readonly keys: readonly Record<string, unknown>[];
};

export type JwtJwks =
  | URL
  | string
  | JsonWebKeySet
  | { readonly secret: Uint8Array | string };

export type DiscoveryInput =
  | string
  | {
      readonly issuer: string;
      readonly metadata?: {
        readonly issuer?: string;
        readonly jwks_uri?: string;
      };
    };

export type JwksCacheOptions = {
  readonly minTtl?: number;
  readonly maxTtl?: number;
  readonly cooldown?: number;
};

export type JoseTokenVerifierOptions = {
  readonly jwks?: JwtJwks;
  readonly discovery?: DiscoveryInput;
  readonly issuer?: string;
  readonly algorithms?: readonly JwtAlgorithm[];
  readonly typ?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly clockTolerance?: number;
  readonly decryptionKeys?: JsonWebKeySet | Record<string, unknown>;
  readonly decryptionAlgorithms?: readonly string[];
  readonly profile?: JwtProfile;
  readonly jwksCache?: JwksCacheOptions;
  readonly fetch?: typeof fetch;
};

export type JoseTokenSignerOptions = {
  readonly key: Record<string, unknown> | Uint8Array;
  readonly alg: JwtAlgorithm;
  readonly kid: string;
  readonly issuer?: string;
};

export type JwtClaimPaths = {
  readonly id?: string;
  readonly roles?: string;
  readonly groups?: string;
  readonly entitlements?: string;
  readonly plans?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly kind?: string;
  readonly assurance?:
    | string
    | {
        readonly acr?: string;
        readonly amr?: string;
        readonly authTime?: string;
        /** OpenID Connect for Identity Assurance; default `verified_claims`. */
        readonly verified?: string;
      };
  readonly session?: string;
};

export type JwtDelegationPaths = {
  readonly scopes?: string;
  readonly authorizationDetails?: string;
  readonly access?: string;
};

export type JwtSubjectOptions = JoseTokenVerifierOptions & {
  readonly accept?: 'access-token' | 'id-token';
  readonly claims?: JwtClaimPaths;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly schema?: StandardSchemaV1;
  readonly delegation?: JwtDelegationPaths;
  readonly actor?:
    | {
        readonly from?: 'act';
        readonly kind?: string;
      }
    | ((claims: JwtClaims) => Actor | undefined);
  readonly sender?: 'none' | 'dpop' | 'mtls';
  readonly memberships?: MembershipSource;
  readonly verifier?: TokenVerifier;
  readonly certificateThumbprint?: string;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

export type JwtPrincipal = Principal & {
  readonly issuer?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

export type DpopProofResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: TokenFailureCause };

export type MappedSubject = Subject<JwtPrincipal>;
