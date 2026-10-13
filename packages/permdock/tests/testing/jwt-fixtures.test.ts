import { describe, expect, it } from "vitest";

import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  jwtFixtureJwks,
  jwtFixtureTokens,
} from "../../src/testing/jwt-fixtures.ts";

describe("jwtFixtureTokens signed outputs", () => {
  const verifier = joseTokenVerifier({
    jwks: jwtFixtureJwks,
    algorithms: ["Ed25519"],
  });

  it.each([
    ["snapshot", "vnd.permdock.snapshot+jwt", "snap_fixture"],
    ["approval", "vnd.permdock.approval+jwt", "apr_fixture"],
    ["decisions", "vnd.permdock.evidence+jwt", "dec_fixture"],
  ] as const)("%s verifies as %s", async (name, typ, jti) => {
    const verified = await verifier.verify(jwtFixtureTokens[name], {
      typ,
      issuer: "https://app.example.com",
    });
    expect(verified.ok).toBe(true);
    expect(verified.ok ? verified.claims["jti"] : undefined).toBe(jti);
  });
});
