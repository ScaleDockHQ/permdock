import type { Membership } from "permdock";

import { createLocalJWKSet, jwtVerify } from "jose";
import {
  SAAS_TOKEN_TTL_SECONDS,
  saasAudience,
  saasIssuer,
  saasJwks,
  signSaasToken,
} from "permdock/testing/saas";

import type { SessionClaims } from "../policy.ts";

export const SESSION_COOKIE = "saas_session";
export const TOKEN_TTL_SECONDS = SAAS_TOKEN_TTL_SECONDS;

const jwks = createLocalJWKSet({ keys: [...saasJwks.keys] });

function isMembership(value: unknown): value is Membership {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // SAFETY: checked to be a non-null object above; both fields stay unknown
  const record = value as { tenant?: unknown; roles?: unknown };
  return (
    typeof record.tenant === "string" &&
    Array.isArray(record.roles) &&
    record.roles.every((role) => typeof role === "string")
  );
}

/** Local verification against a static JWKS: no network, never throws. */
export async function verifySession(
  token: string | undefined,
): Promise<SessionClaims | null> {
  if (token === undefined || token === "") {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: saasIssuer,
      audience: saasAudience,
      algorithms: ["ES256"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number"
    ) {
      return null;
    }
    const memberships = Array.isArray(payload["memberships"])
      ? payload["memberships"].filter((item) => isMembership(item))
      : undefined;
    return {
      sub: payload.sub,
      exp: payload.exp,
      iat: payload.iat,
      ...(memberships === undefined ? {} : { memberships }),
    };
  } catch {
    return null;
  }
}

export function signSession(
  sub: string,
  memberships: readonly Membership[] | undefined,
): Promise<string> {
  return signSaasToken(sub, { memberships: memberships ?? false });
}
