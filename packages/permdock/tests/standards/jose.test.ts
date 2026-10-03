import {
  CompactEncrypt,
  SignJWT,
  UnsecuredJWT,
  base64url,
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import { describe, expect, it } from "vitest";

import type { TokenSigner } from "../../src/core/interfaces.ts";

import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import { standardsFixture } from "./fixtures.ts";

const rfc8037 = standardsFixture("rfc8037-ed25519.json");
const rfc7520 = standardsFixture("rfc7520-jws.json");

const ISSUER = "https://login.example.com";
const NOW = Math.floor(Date.now() / 1000);

function encodeHeader(header: Record<string, unknown>): string {
  return base64url.encode(JSON.stringify(header));
}

function tamper(jws: string): string {
  const [header = "", payload = "", signature = ""] = jws.split(".");
  const flipped = signature.startsWith("A")
    ? `B${signature.slice(1)}`
    : `A${signature.slice(1)}`;
  return `${header}.${payload}.${flipped}`;
}

async function causeOf(
  verifier: ReturnType<typeof joseTokenVerifier>,
  token: string,
): Promise<string> {
  const result = await verifier.verify(token, {});
  return result.ok ? "ok" : result.cause;
}

async function ed25519(kid: string): Promise<{
  readonly privateJwk: Record<string, unknown>;
  readonly publicJwk: Record<string, unknown>;
}> {
  const pair = await generateKeyPair("Ed25519", { extractable: true });
  return {
    privateJwk: { ...(await exportJWK(pair.privateKey)), kid },
    publicJwk: { ...(await exportJWK(pair.publicKey)), kid },
  };
}

async function signed(
  jwk: Record<string, unknown>,
  header: Record<string, unknown>,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const alg = String(header["alg"]);
  const key = await importJWK(jwk, alg === "EdDSA" ? "Ed25519" : alg);
  return new SignJWT({ sub: "u_1", ...claims })
    .setProtectedHeader({ alg, ...header })
    .setIssuer(ISSUER)
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .sign(key);
}

describe("RFC 8037 CFRG curves in JOSE (January 2017)", () => {
  it("appendix A.3: the Ed25519 public key has the published JWK thumbprint", async () => {
    await expect(calculateJwkThumbprint(rfc8037.publicKey)).resolves.toBe(
      rfc8037.thumbprint,
    );
  });

  it("appendix A.4 and A.5: the Ed25519 JWS verifies with the published key", async () => {
    const key = await importJWK(rfc8037.publicKey, "Ed25519");
    const { payload, protectedHeader } = await compactVerify(rfc8037.jws, key);
    expect(protectedHeader).toEqual({ alg: "EdDSA" });
    expect(new TextDecoder().decode(payload)).toBe(
      "Example of Ed25519 signing",
    );
  });

  it("appendix A.4: joseTokenVerifier accepts the signature and rejects the non-JWT payload", async () => {
    const verifier = joseTokenVerifier({
      jwks: { keys: [{ ...rfc8037.publicKey, kid: "rfc8037" }] },
      issuer: ISSUER,
    });
    expect(await causeOf(verifier, rfc8037.jws)).toBe("malformed");
    expect(await causeOf(verifier, tamper(rfc8037.jws))).toBe(
      "invalid-signature",
    );
  });
});

describe("RFC 7520 JOSE Cookbook (May 2015)", () => {
  const payload =
    "It\u2019s a dangerous business, Frodo, going out your door. You step onto the road, and if you don't keep your feet, there\u2019s no knowing where you might be swept off to.";

  it("section 4.1: the RS256 example verifies with the figure 3 key", async () => {
    const key = await importJWK(rfc7520.rsaPublicKey, "RS256");
    const result = await compactVerify(rfc7520.rs256, key);
    expect(result.protectedHeader).toEqual({
      alg: "RS256",
      kid: "bilbo.baggins@hobbiton.example",
    });
    expect(new TextDecoder().decode(result.payload)).toBe(payload);
  });

  it("section 4.1: joseTokenVerifier selects the key by kid and checks the signature", async () => {
    const verifier = joseTokenVerifier({
      jwks: { keys: [rfc7520.rsaPublicKey] },
      issuer: ISSUER,
    });
    expect(await causeOf(verifier, rfc7520.rs256)).toBe("malformed");
    expect(await causeOf(verifier, tamper(rfc7520.rs256))).toBe(
      "invalid-signature",
    );
  });

  it("section 4.4: the HS256 example verifies only with an explicit secret", async () => {
    const secret = base64url.decode(String(rfc7520.hmacKey["k"]));
    const result = await compactVerify(rfc7520.hs256, secret);
    expect(new TextDecoder().decode(result.payload)).toBe(payload);
    const hmac = joseTokenVerifier({
      jwks: { secret },
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(await causeOf(hmac, rfc7520.hs256)).toBe("malformed");
    expect(await causeOf(hmac, tamper(rfc7520.hs256))).toBe(
      "invalid-signature",
    );
    const asymmetric = joseTokenVerifier({
      jwks: { keys: [rfc7520.rsaPublicKey] },
      issuer: ISSUER,
    });
    expect(["alg-not-allowed", "unknown-kid"]).toContain(
      await causeOf(asymmetric, rfc7520.hs256),
    );
  });
});

describe("RFC 8725 JWT Best Current Practices (February 2020)", () => {
  it("section 3.1: alg none is refused", async () => {
    const { publicJwk } = await ed25519("k1");
    const verifier = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
    });
    const unsecured = new UnsecuredJWT({ sub: "u_1" })
      .setIssuer(ISSUER)
      .setExpirationTime(NOW + 300)
      .encode();
    expect(await causeOf(verifier, unsecured)).toBe("alg-none");
  });

  it("section 3.1: an alg outside the allow-list is refused even with a matching key", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privateJwk = { ...(await exportJWK(pair.privateKey)), kid: "rsa" };
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "rsa" };
    const token = await signed(privateJwk, { alg: "RS256", kid: "rsa" });
    const fapi = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
      profile: "fapi2",
    });
    expect(await causeOf(fapi, token)).toBe("alg-not-allowed");
    const pinned = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
      algorithms: ["ES256"],
    });
    expect(await causeOf(pinned, token)).toBe("alg-not-allowed");
  });

  it("section 3.2: RSA1_5 key management is refused", async () => {
    const verifier = joseTokenVerifier({
      jwks: { keys: [] },
      issuer: ISSUER,
      decryptionKeys: { kty: "oct", k: base64url.encode(new Uint8Array(32)) },
    });
    const header = encodeHeader({
      alg: "RSA1_5",
      enc: "A128CBC-HS256",
      cty: "JWT",
    });
    expect(await causeOf(verifier, `${header}.AA.AA.AA.AA`)).toBe(
      "encrypted-token",
    );
    const jwe = await new CompactEncrypt(new TextEncoder().encode("x.y.z"))
      .setProtectedHeader({
        alg: "dir",
        enc: "A256GCM",
        cty: "JWT",
        zip: "DEF",
      })
      .encrypt(new Uint8Array(32));
    expect(await causeOf(verifier, jwe)).toBe("encrypted-token");
  });

  it("section 3.10: jku, x5u and jwk headers never supply the key", async () => {
    const trusted = await ed25519("trusted");
    const attacker = await ed25519("trusted");
    const verifier = joseTokenVerifier({
      jwks: { keys: [trusted.publicJwk] },
      issuer: ISSUER,
    });
    const token = await signed(attacker.privateJwk, {
      alg: "Ed25519",
      kid: "trusted",
      jku: "https://attacker.example/jwks.json",
      x5u: "https://attacker.example/cert.pem",
      jwk: attacker.publicJwk,
    });
    expect(await causeOf(verifier, token)).toBe("invalid-signature");
  });

  it("section 3.10: a kid outside the key set is unknown-kid, and crit with an unknown name is malformed", async () => {
    const { privateJwk, publicJwk } = await ed25519("k1");
    const verifier = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
    });
    const other = await signed(privateJwk, { alg: "Ed25519", kid: "k2" });
    expect(await causeOf(verifier, other)).toBe("unknown-kid");
    const crit = encodeHeader({
      alg: "Ed25519",
      kid: "k1",
      crit: ["x-unknown"],
      "x-unknown": true,
    });
    const [, payload = "", signature = ""] = other.split(".");
    expect(await causeOf(verifier, `${crit}.${payload}.${signature}`)).toBe(
      "malformed",
    );
  });

  it("section 3.11: typ is checked when a verifier pins it", async () => {
    const { privateJwk, publicJwk } = await ed25519("k1");
    const verifier = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
      typ: "at+jwt",
    });
    const id = await signed(privateJwk, {
      alg: "Ed25519",
      kid: "k1",
      typ: "JWT",
    });
    expect(await causeOf(verifier, id)).toBe("wrong-token-type");
    const access = await signed(privateJwk, {
      alg: "Ed25519",
      kid: "k1",
      typ: "at+jwt",
    });
    expect(await causeOf(verifier, access)).toBe("ok");
  });

  it("bis: EdDSA is accepted only for an Ed25519 key", async () => {
    const rfcKey = { ...rfc8037.privateKey, kid: "rfc8037" };
    const verifier = joseTokenVerifier({
      jwks: { keys: [{ ...rfc8037.publicKey, kid: "rfc8037" }] },
      issuer: ISSUER,
    });
    const polymorphic = await signed(rfcKey, { alg: "EdDSA", kid: "rfc8037" });
    expect(await causeOf(verifier, polymorphic)).toBe("ok");
    const ec = await generateKeyPair("ES256", { extractable: true });
    const ecVerifier = joseTokenVerifier({
      jwks: { keys: [{ ...(await exportJWK(ec.publicKey)), kid: "ec" }] },
      issuer: ISSUER,
    });
    const header = encodeHeader({ alg: "EdDSA", kid: "ec" });
    const forged = `${header}.${polymorphic.split(".")[1] ?? ""}.${polymorphic.split(".")[2] ?? ""}`;
    expect(await causeOf(ecVerifier, forged)).toBe("alg-not-allowed");
  });

  it("bis: a token without exp is rejected", async () => {
    const { privateJwk, publicJwk } = await ed25519("k1");
    const verifier = joseTokenVerifier({
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
    });
    const key = await importJWK(privateJwk, "Ed25519");
    const token = await new SignJWT({ sub: "u_1" })
      .setProtectedHeader({ alg: "Ed25519", kid: "k1" })
      .setIssuer(ISSUER)
      .setIssuedAt(NOW)
      .sign(key);
    expect(["expired", "invalid-claims", "malformed"]).toContain(
      await causeOf(verifier, token),
    );
    expect(await causeOf(verifier, token)).not.toBe("ok");
  });
});

describe("PermDock outputs: compact JWS with registered headers", () => {
  const TYPES = [
    "permdock-snapshot+jwt",
    "permdock-approval+jwt",
    "permdock-decisions+jwt",
    "permdock-policy+jwt",
    "permdock-capability+jwt",
  ] as const satisfies readonly Parameters<TokenSigner["sign"]>[1]["typ"][];

  it("every typ carries alg, kid and typ only, and round-trips through joseTokenVerifier", async () => {
    const { privateJwk } = await ed25519("2026-10");
    const signer = joseTokenSigner({
      key: privateJwk,
      alg: "Ed25519",
      kid: "2026-10",
      issuer: ISSUER,
    });
    const jwks = await signer.jwks?.();
    expect(jwks?.keys[0]).not.toHaveProperty("d");
    for (const typ of TYPES) {
      const token = await signer.sign(
        { payload: typ },
        { typ, audience: "https://api.example.com", expiresAt: NOW + 60 },
      );
      expect(token.split(".")).toHaveLength(3);
      expect(decodeProtectedHeader(token)).toEqual({
        alg: "Ed25519",
        kid: "2026-10",
        typ,
      });
      const claims = decodeJwt(token);
      expect(claims).toMatchObject({
        iss: ISSUER,
        aud: "https://api.example.com",
        exp: NOW + 60,
      });
      expect(typeof claims.iat).toBe("number");
      expect(typeof claims.jti).toBe("string");
      const verifier = joseTokenVerifier({
        jwks: { keys: jwks?.keys ?? [] },
        issuer: ISSUER,
        audience: "https://api.example.com",
        typ,
      });
      expect(await causeOf(verifier, token)).toBe("ok");
    }
  });

  it("a signer refuses HS256, polymorphic EdDSA and an empty kid", () => {
    expect(() =>
      joseTokenSigner({ key: new Uint8Array(32), alg: "HS256", kid: "k" }),
    ).toThrow(/refuses HS\* and polymorphic EdDSA/u);
    expect(() =>
      joseTokenSigner({ key: rfc8037.privateKey, alg: "EdDSA", kid: "k" }),
    ).toThrow(/refuses HS\* and polymorphic EdDSA/u);
    expect(() =>
      joseTokenSigner({ key: rfc8037.privateKey, alg: "Ed25519", kid: "" }),
    ).toThrow(/requires kid/u);
  });
});
