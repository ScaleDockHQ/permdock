import { d as Subject, t as Actor, u as Principal } from "./subject-BcgWbogX.js";
import { M as TokenFailureCause, P as TokenVerifier, T as MembershipSource, g as AuthEvent, x as JwtClaims } from "./policy-CrXDbTAD.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/jwt/types.d.ts
type JwtAlgorithm = "ES256" | "PS256" | "Ed25519" | "RS256" | "HS256" | "EdDSA";
type JwtProfile = "fapi2";
type JsonWebKeySet = {
  readonly keys: readonly Record<string, unknown>[];
};
type JwtJwks = URL | JsonWebKeySet | {
  readonly secret: Uint8Array | string;
};
type DiscoveryInput = string | {
  readonly issuer: string;
  readonly metadata?: {
    readonly issuer?: string;
    readonly jwks_uri?: string;
  };
};
type JwksCacheOptions = {
  readonly minTtl?: number;
  readonly maxTtl?: number;
  readonly cooldown?: number;
};
type JoseTokenVerifierOptions = {
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
type JoseTokenSignerOptions = {
  readonly key: Record<string, unknown> | Uint8Array;
  readonly alg: JwtAlgorithm;
  readonly kid: string;
  readonly issuer?: string;
};
type JwtClaimPaths = {
  readonly id?: string;
  readonly roles?: string;
  readonly groups?: string;
  readonly entitlements?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly kind?: string;
  readonly assurance?: string | {
    readonly acr?: string;
    readonly amr?: string;
    readonly authTime?: string;
  };
  readonly session?: string;
};
type JwtDelegationPaths = {
  readonly scopes?: string;
  readonly authorizationDetails?: string;
  readonly access?: string;
};
type JwtSubjectOptions = JoseTokenVerifierOptions & {
  readonly accept?: "access-token" | "id-token";
  readonly claims?: JwtClaimPaths;
  readonly groupRoles?: Readonly<Record<string, readonly string[]>>;
  readonly schema?: StandardSchemaV1;
  readonly delegation?: JwtDelegationPaths;
  readonly actor?: {
    readonly from?: "act";
    readonly kind?: string;
  } | ((claims: JwtClaims) => Actor | undefined);
  readonly sender?: "none" | "dpop" | "mtls";
  readonly memberships?: MembershipSource;
  readonly verifier?: TokenVerifier;
  readonly certificateThumbprint?: string;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};
type JwtPrincipal = Principal & {
  readonly issuer?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};
type DpopProofResult = {
  readonly ok: true;
} | {
  readonly ok: false;
  readonly cause: TokenFailureCause;
};
type MappedSubject = Subject<JwtPrincipal>;
//#endregion
export { JsonWebKeySet as a, JwtJwks as c, MappedSubject as d, JoseTokenVerifierOptions as i, JwtPrincipal as l, DpopProofResult as n, JwtAlgorithm as o, JoseTokenSignerOptions as r, JwtClaimPaths as s, DiscoveryInput as t, JwtSubjectOptions as u };