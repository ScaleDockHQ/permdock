import type { DecodedHeader } from "./header.ts";
import type { JoseModule } from "./load-jose.ts";
import type { JoseTokenVerifierOptions } from "./types.ts";

import { DEFAULT_DECRYPTION_ALGS } from "./config.ts";

const CONTENT_ENCRYPTION: readonly string[] = ["A128GCM", "A192GCM", "A256GCM"];

type Jwk = Record<string, unknown>;

function configuredKeys(
  listed: NonNullable<JoseTokenVerifierOptions["decryptionKeys"]>,
): readonly Jwk[] {
  // SAFETY: checked to be an array; every entry is checked before use.
  return "keys" in listed && Array.isArray(listed.keys)
    ? (listed.keys as readonly Jwk[])
    : [listed];
}

function isObject(value: unknown): value is Jwk {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether `key` may decrypt a token with this header: encryption use, matching
 * `alg` and `kid`, and private material.
 */
function mayDecrypt(key: unknown, header: DecodedHeader): key is Jwk {
  if (!isObject(key)) {
    return false;
  }
  if (key["use"] !== undefined && key["use"] !== "enc") {
    return false;
  }
  if (key["alg"] !== undefined && key["alg"] !== header.alg) {
    return false;
  }
  if (header.kid !== undefined && key["kid"] !== header.kid) {
    return false;
  }
  if (key["kty"] === "oct") {
    return typeof key["k"] === "string";
  }
  return typeof key["d"] === "string";
}

/**
 * The inner JWS of a nested JWE, decrypted with the first configured private
 * key that opens it, or `undefined`. Never throws; the caller has already
 * refused `zip`, `RSA1_5` and a missing `cty: JWT`.
 */
export async function decryptWithKeys(
  jose: JoseModule,
  token: string,
  header: DecodedHeader,
  options: Pick<
    JoseTokenVerifierOptions,
    "decryptionKeys" | "decryptionAlgorithms"
  >,
): Promise<string | undefined> {
  if (options.decryptionKeys === undefined || header.alg === undefined) {
    return undefined;
  }
  const keyManagementAlgorithms = [
    ...(options.decryptionAlgorithms ?? DEFAULT_DECRYPTION_ALGS),
  ].filter((alg) => alg !== "RSA1_5");
  for (const jwk of configuredKeys(options.decryptionKeys)) {
    if (!mayDecrypt(jwk, header)) {
      continue;
    }
    try {
      // SAFETY: a configured private JWK; importJWK rejects a malformed key and jose re-checks it against alg.
      // oxlint-disable-next-line no-await-in-loop -- the first key that opens the token wins; the rest are not tried
      const key = await jose.importJWK(jwk as never, header.alg);
      // oxlint-disable-next-line no-await-in-loop -- the first key that opens the token wins; the rest are not tried
      const { plaintext } = await jose.compactDecrypt(token, key, {
        keyManagementAlgorithms,
        contentEncryptionAlgorithms: [...CONTENT_ENCRYPTION],
      });
      return new TextDecoder().decode(plaintext);
    } catch {
      continue;
    }
  }
  return undefined;
}
