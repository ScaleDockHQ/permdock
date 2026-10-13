import { describe, expect, it } from "vitest";

import type { TokenSigner } from "../../src/core/interfaces.ts";

import { subjectFromCapability } from "../../src/jwt/capability.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { subjectFromJwt } from "../../src/jwt/subject.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
  alg: "Ed25519",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const JWKS = { keys: [PUBLIC_JWK] };
const ISSUER = "https://app.example.com";
const AUDIENCE = "https://app.example.com";

const signer = joseTokenSigner({
  key: PRIVATE_JWK,
  alg: "Ed25519",
  kid: "2026-09",
  issuer: ISSUER,
});

type Typ = Parameters<TokenSigner["sign"]>[1]["typ"];

const TYPS: readonly Typ[] = [
  "vnd.permdock.snapshot+jwt",
  "vnd.permdock.approval+jwt",
  "vnd.permdock.policy+jwt",
  "vnd.permdock.capability+jwt",
  "vnd.permdock.run+jwt",
  "vnd.permdock.support-session+jwt",
  "vnd.permdock.evidence+jwt",
];

const capabilityClaim = {
  v: 1,
  holder: "link",
  on: { resource: "quote", id: "q1" },
  roles: ["guest"],
};

function sign(typ: Typ): Promise<string> {
  return signer.sign(
    { sub: "lnk_1", capability: capabilityClaim },
    { typ, audience: AUDIENCE, jti: "lnk_1" },
  );
}

const verifier = joseTokenVerifier({ jwks: JWKS, algorithms: ["Ed25519"] });

describe("one typ per purpose", () => {
  it("names seven vendor-tree media types", () => {
    for (const typ of TYPS) {
      expect(typ).toMatch(/^vnd\.permdock\.[a-z-]+\+jwt$/u);
    }
    expect(new Set(TYPS).size).toBe(7);
  });

  it.each(TYPS)("each verifier accepts only its own typ (%s)", async (typ) => {
    const token = await sign(typ);
    for (const expected of TYPS) {
      const verified = await verifier.verify(token, {
        typ: expected,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (expected === typ) {
        expect(verified.ok).toBe(true);
      } else {
        expect(verified).toMatchObject({
          ok: false,
          cause: "wrong-token-type",
        });
      }
    }
  });

  it.each(TYPS.filter((typ) => typ !== "vnd.permdock.capability+jwt"))(
    "subjectFromCapability refuses a %s",
    async (typ) => {
      const causes: unknown[] = [];
      const subject = await subjectFromCapability(await sign(typ), {
        jwks: JWKS,
        issuer: ISSUER,
        audience: AUDIENCE,
        onAuth: (event) => {
          causes.push(event.cause);
        },
      });
      expect(subject.principal).toBeNull();
      expect(causes).toEqual(["wrong-token-type"]);
    },
  );

  it.each(TYPS)(
    "subjectFromJwt refuses a %s as an access token",
    async (typ) => {
      const causes: unknown[] = [];
      const subject = await subjectFromJwt(await sign(typ), {
        jwks: JWKS,
        issuer: ISSUER,
        audience: AUDIENCE,
        onAuth: (event) => {
          causes.push(event.cause);
        },
      });
      expect(subject.principal).toBeNull();
      expect(causes).toEqual(["wrong-token-type"]);
    },
  );
});
