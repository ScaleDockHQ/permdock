import type { Subject } from "../core/subject.ts";

import { parseCapability } from "../core/capability.ts";
import { loadJose } from "../jwt/load-jose.ts";

export type ExchangeCapabilityOptions = {
  /**
   * The key Supabase verifies with: a private JWK imported into the project's
   * JWT signing keys (`ES256` or `RS256`, with its `kid`), or the legacy JWT
   * secret (`HS256`).
   */
  readonly key: Record<string, unknown> | { readonly secret: string };
  /** Default `ES256`, Supabase's asymmetric signing key; the legacy secret needs `HS256` named. */
  readonly alg?: "ES256" | "RS256" | "HS256";
  readonly kid?: string;
  readonly issuer?: string;
  /** Lifetime in seconds, capped by the capability's own expiry. Default 300. */
  readonly ttl?: number;
  readonly now?: number;
};

const DEFAULT_TTL = 300;
const MAX_TTL = 3600;

function isSecret(
  key: ExchangeCapabilityOptions["key"],
): key is { readonly secret: string } {
  return typeof key.secret === "string";
}

/**
 * Exchanges a verified link subject (from `subjectFromCapability`) for a
 * short-lived Supabase access token with role `anon` and the capability in a
 * `capability` claim, which `permdock rls generate --capabilities` policies
 * read. `undefined` for any subject that is not a live link.
 */
export async function exchangeCapability(
  subject: Subject,
  options: ExchangeCapabilityOptions,
): Promise<string | undefined> {
  const alg = options.alg ?? "ES256";
  const secret = isSecret(options.key);
  if (secret !== (alg === "HS256")) {
    throw new Error(
      "PermDock: exchangeCapability signs HS256 with { secret } only, and ES256 / RS256 with a private JWK only.",
    );
  }
  if (!secret && (options.kid === undefined || options.kid.length === 0)) {
    throw new Error(
      "PermDock: exchangeCapability needs the kid of the imported signing key.",
    );
  }
  const principal = subject.principal;
  if (principal === null || principal.kind !== "link") {
    return undefined;
  }
  const capability = parseCapability(principal["capability"]);
  if (capability?.holder !== "link" || capability.id !== principal.id) {
    return undefined;
  }
  const now = Math.floor(options.now ?? Date.now() / 1000);
  const ttl = Math.min(Math.max(1, options.ttl ?? DEFAULT_TTL), MAX_TTL);
  const exp = Math.min(now + ttl, Math.floor(capability.expiresAt));
  if (exp <= now) {
    return undefined;
  }
  const jose = await loadJose();
  // SAFETY: a non-secret key is the private JWK the options type declares; jose validates it on import.
  const key = isSecret(options.key)
    ? new TextEncoder().encode(options.key.secret)
    : await jose.importJWK(options.key as never, alg);
  // No `sub`: `auth.uid()` casts it to uuid, and a link id is not a user.
  const jwt = new jose.SignJWT({ role: "anon", capability })
    .setProtectedHeader(
      secret
        ? { alg: "HS256", typ: "JWT" }
        : {
            alg,
            ...(options.kid === undefined ? {} : { kid: options.kid }),
            typ: "JWT",
          },
    )
    .setIssuedAt(now)
    .setExpirationTime(exp);
  if (options.issuer !== undefined) {
    jwt.setIssuer(options.issuer);
  }
  return jwt.sign(key);
}
