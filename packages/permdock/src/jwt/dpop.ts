import type { JwtClaims } from "../core/interfaces.ts";
import type { DpopProofResult } from "./types.ts";

import { bytesToBase64Url, sha256 } from "../core/sha256.ts";
import { decodeHeader } from "./header.ts";
import { loadJose } from "./load-jose.ts";

const DPOP_WINDOW_SECONDS = 60;
// RFC 9449 section 4.3: an asymmetric signature algorithm and a public key only.
const PROOF_ALGS: ReadonlySet<string> = new Set([
  "ES256",
  "PS256",
  "Ed25519",
  "EdDSA",
  "RS256",
]);
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;

function headerOf(request: Request): string | null {
  return request.headers.get("DPoP") ?? request.headers.get("dpop");
}

function requestUrl(request: Request): string {
  const url = new URL(request.url);
  url.hash = "";
  return url.href;
}

export function verifyDpopProof(
  request: Request,
  claims: JwtClaims,
  accessToken?: string,
): Promise<DpopProofResult> {
  return verify(request, claims, accessToken);
}

async function verify(
  request: Request,
  claims: JwtClaims,
  accessToken: string | undefined,
): Promise<DpopProofResult> {
  const proof = headerOf(request);
  if (proof === null || proof.length === 0) {
    return { ok: false, cause: "dpop-proof-invalid" };
  }
  // SAFETY: cnf was checked to be a non-array object, and jkt to be a string, before it is read.
  const expectedJkt =
    claims["cnf"] !== null &&
    typeof claims["cnf"] === "object" &&
    !Array.isArray(claims["cnf"]) &&
    typeof (claims["cnf"] as { readonly jkt?: unknown }).jkt === "string"
      ? (claims["cnf"] as { readonly jkt: string }).jkt
      : undefined;
  if (expectedJkt === undefined) {
    return { ok: false, cause: "dpop-proof-invalid" };
  }
  const header = decodeHeader(proof);
  if (header?.typ?.toLowerCase() !== "dpop+jwt") {
    return { ok: false, cause: "dpop-proof-invalid" };
  }
  const jwk = header["jwk"];
  if (
    !PROOF_ALGS.has(header.alg ?? "") ||
    jwk === null ||
    typeof jwk !== "object" ||
    Array.isArray(jwk) ||
    PRIVATE_MEMBERS.some((member) => member in jwk)
  ) {
    return { ok: false, cause: "dpop-proof-invalid" };
  }
  try {
    const jose = await loadJose();
    // SAFETY: jwk was checked to be a non-array object; importJWK rejects a malformed key.
    const key = await jose.importJWK(jwk as never, header.alg);
    const result = await jose.jwtVerify(proof, key, {
      typ: "dpop+jwt",
      maxTokenAge: DPOP_WINDOW_SECONDS,
    });
    // SAFETY: the same jwk that importJWK accepted and the proof verified against above.
    const jkt = await jose.calculateJwkThumbprint(jwk as never, "sha256");
    if (jkt !== expectedJkt) {
      return { ok: false, cause: "dpop-proof-invalid" };
    }
    const htm = result.payload["htm"];
    const htu = result.payload["htu"];
    if (htm !== request.method || htu !== requestUrl(request)) {
      return { ok: false, cause: "dpop-proof-invalid" };
    }
    if (accessToken !== undefined) {
      const ath = bytesToBase64Url(sha256(accessToken));
      if (result.payload["ath"] !== ath) {
        return { ok: false, cause: "dpop-proof-invalid" };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, cause: "dpop-proof-invalid" };
  }
}
