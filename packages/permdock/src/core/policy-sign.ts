import type { PolicyDocument } from "./hosted.ts";
import type { TokenSigner } from "./interfaces.ts";

import { secondsOf } from "./time.ts";

export type SignPolicyDocumentOptions = {
  /** `aud`: the environment URL `cloud().policies` checks it against. */
  readonly audience: string | readonly string[];
  /**
   * `exp`, a NumericDate; the signer's default (one hour after `iat`) when
   * absent.
   */
  readonly expiresAt?: number;
};

/**
 * Signs `document` as a `vnd.permdock.policy+jwt`: the `policy` claim holds
 * every field but `id` and `issuedAt`, which become `jti` and `iat`, so
 * `policyDocumentFromClaims` reads it back. `iss` is the signer's own.
 */
export function signPolicyDocument(
  document: PolicyDocument,
  signer: TokenSigner,
  options: SignPolicyDocumentOptions,
): Promise<string> {
  const { id, issuedAt, ...policy } = document;
  const iat = secondsOf(issuedAt);
  return signer.sign(
    { policy },
    {
      typ: "vnd.permdock.policy+jwt",
      audience: options.audience,
      jti: id,
      ...(iat === undefined ? {} : { issuedAt: iat }),
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
    },
  );
}
