import type { TokenSigner } from "../core/interfaces.ts";
import type { JsonWebKeyLike } from "../core/subject.ts";
import type { CloudSignerOptions } from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { cloudConnection, isCompactJws } from "./request.ts";

type SignOptions = Parameters<TokenSigner["sign"]>[1];

const REGISTERED: ReadonlySet<string> = new Set([
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
]);

/**
 * The Cloud's own outputs and access tokens; a client key that could mint them
 * could forge them, or forge the approver behind `PermDock-Approver`.
 */
const CLOUD_ISSUED: ReadonlySet<string> = new Set([
  "vnd.permdock.policy+jwt",
  "vnd.permdock.snapshot+jwt",
  "vnd.permdock.evidence+jwt",
  "at+jwt",
  "secevent+jwt",
]);

function headerTyp(token: string): unknown {
  const [encoded = ""] = token.split(".");
  try {
    const text = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const header: unknown = JSON.parse(text);
    return isRecord(header) ? header["typ"] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `TokenSigner` backed by the environment's PermDock Cloud keys, typically
 * KMS-held, for run tickets (`vnd.permdock.run+jwt`) and every other signed
 * output an app issues. The Cloud signs only what the app sends: it sets `iss`
 * to the environment URL and adds no claim. Policy documents, snapshots,
 * evidence exports, Security Event Tokens and `at+jwt` access tokens are the
 * Cloud's own outputs, so their `typ` values are refused here. Verify what it
 * signs with `joseTokenVerifier({ jwks: cloudEndpoints().jwks })`.
 */
export function cloudSigner(options: CloudSignerOptions = {}): TokenSigner {
  const connection = cloudConnection(options);
  return Object.freeze({
    async sign(
      payload: Readonly<Record<string, unknown>>,
      signOptions: SignOptions,
    ): Promise<string> {
      if (CLOUD_ISSUED.has(signOptions.typ)) {
        throw new Error(
          `PermDock: cloudSigner never signs ${signOptions.typ}; the Cloud issues its own.`,
        );
      }
      const audience = signOptions.audience ?? options.audience;
      if (audience === undefined || audience.length === 0) {
        throw new Error("PermDock: cloudSigner requires an audience.");
      }
      const claims = Object.fromEntries(
        Object.entries(payload).filter(([name]) => !REGISTERED.has(name)),
      );
      const response = await connection.request(
        "/sign",
        {
          method: "POST",
          body: JSON.stringify(
            compact({
              typ: signOptions.typ,
              claims,
              aud: audience,
              exp: signOptions.expiresAt,
              iat: signOptions.issuedAt,
              jti: signOptions.jti,
            }),
          ),
        },
        "application/jwt",
      );
      if (!response.ok) {
        throw new Error(
          `PermDock Cloud refused to sign: HTTP ${String(response.status)}`,
        );
      }
      const token = (await response.text()).trim();
      if (!isCompactJws(token) || headerTyp(token) !== signOptions.typ) {
        throw new Error(
          `PermDock Cloud returned a token that is not a ${signOptions.typ} JWS`,
        );
      }
      return token;
    },
    async jwks(): Promise<{ readonly keys: readonly JsonWebKeyLike[] }> {
      try {
        const response = await connection.request(
          "/.well-known/jwks.json",
          {},
          "application/jwk-set+json",
        );
        const body: unknown = response.ok ? await response.json() : undefined;
        const keys =
          isRecord(body) && Array.isArray(body["keys"]) ? body["keys"] : [];
        return { keys: keys.filter(isRecord) };
      } catch {
        return { keys: [] };
      }
    },
  });
}
