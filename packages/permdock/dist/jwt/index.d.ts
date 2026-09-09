import { M as TokenVerifier, j as TokenSigner, x as JwtClaims } from "../policy-DdqgAkJT.js";
import { a as JsonWebKeySet, c as JwtJwks, d as MappedSubject, i as JoseTokenVerifierOptions, l as JwtPrincipal, n as DpopProofResult, o as JwtAlgorithm, r as JoseTokenSignerOptions, s as JwtClaimPaths, t as DiscoveryInput, u as JwtSubjectOptions } from "../types-DqS7JCiX.js";
//#region src/jwt/dpop.d.ts
export declare function verifyDpopProof(request: Request, claims: JwtClaims, accessToken?: string): Promise<DpopProofResult>;
//#endregion
//#region src/jwt/signer.d.ts
export declare function joseTokenSigner(options: JoseTokenSignerOptions): TokenSigner;
//#endregion
//#region src/jwt/subject.d.ts
export declare function subjectFromJwt(token: string | undefined | null, options: JwtSubjectOptions, request?: Request): Promise<MappedSubject>;
export declare function createJwtSubjectResolver(options: JwtSubjectOptions): (token: string | undefined | null, request?: Request) => Promise<MappedSubject>;
//#endregion
//#region src/jwt/verifier.d.ts
export declare function joseTokenVerifier(options: JoseTokenVerifierOptions): TokenVerifier;
//#endregion
export type { DiscoveryInput, DpopProofResult, JoseTokenSignerOptions, JoseTokenVerifierOptions, JsonWebKeySet, JwtAlgorithm, JwtClaimPaths, JwtJwks, JwtPrincipal, JwtSubjectOptions, MappedSubject };