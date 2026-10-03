import {
  CompactEncrypt,
  CompactSign,
  SignJWT,
  base64url,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { JoseTokenVerifierOptions } from "../../src/jwt/types.ts";

import { createKeyCache } from "../../src/jwt/cache.ts";
import { assertSubjectConfig } from "../../src/jwt/config.ts";
import {
  decodeHeader,
  normalizeTyp,
  unknownCrit,
} from "../../src/jwt/header.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";

const ISSUER = "https://login.test";
const AUDIENCE = "https://api.test";
const NOW = 1_800_000_000;

let es: { readonly private: CryptoKey; readonly jwk: Record<string, unknown> };
let ed: { readonly private: CryptoKey; readonly jwk: Record<string, unknown> };

beforeAll(async () => {
  const esPair = await generateKeyPair("ES256", { extractable: true });
  es = {
    private: esPair.privateKey,
    jwk: { ...(await exportJWK(esPair.publicKey)), kid: "es-1", alg: "ES256" },
  };
  const edPair = await generateKeyPair("Ed25519", { extractable: true });
  ed = {
    private: edPair.privateKey,
    jwk: { ...(await exportJWK(edPair.publicKey)), kid: "ed-1" },
  };
});

async function sign(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: CryptoKey | Uint8Array = es.private,
): Promise<string> {
  return new SignJWT({ sub: "u1", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "es-1", typ: "at+jwt", ...header })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(NOW - 10)
    .setExpirationTime(NOW + 3600)
    .sign(key);
}

function verifier(options: Partial<JoseTokenVerifierOptions> = {}) {
  return joseTokenVerifier({
    jwks: { keys: [es.jwk, ed.jwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    ...options,
  });
}

async function causeOf(
  token: string,
  options: Partial<JoseTokenVerifierOptions> = {},
  expectations: Parameters<ReturnType<typeof verifier>["verify"]>[1] = {},
): Promise<string> {
  const result = await verifier(options).verify(token, expectations);
  return result.ok ? "ok" : result.cause;
}

describe("joseTokenVerifier header checks", () => {
  it("maps typ, kid and alg combinations", async () => {
    const edToken = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "ed-1", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(NOW + 3600)
      .sign(ed.private);
    const cases: readonly [
      string,
      string,
      Partial<JoseTokenVerifierOptions>,
    ][] = [
      ["typ JWT", await sign({}, { typ: "JWT" }), {}],
      [
        "typ application/at+jwt",
        await sign({}, { typ: "application/at+jwt" }),
        {},
      ],
      ["no typ", await sign({}, { typ: undefined }), {}],
      ["typ dpop+jwt", await sign({}, { typ: "dpop+jwt" }), {}],
      [
        "fapi2 without typ",
        await sign({}, { typ: undefined }),
        { profile: "fapi2" },
      ],
      ["EdDSA with an Ed25519 key", edToken, {}],
      ["EdDSA without Ed25519", edToken, { algorithms: ["ES256"] }],
      ["ES256 not allowed", await sign(), { algorithms: ["PS256"] }],
      ["no kid with two keys", await sign({}, { kid: undefined }), {}],
      [
        "no kid with one key",
        await sign({}, { kid: undefined }),
        { jwks: { keys: [es.jwk] } },
      ],
    ];
    const results = [];
    for (const [label, token, options] of cases) {
      results.push([label, await causeOf(token, options)]);
    }
    expect(results).toEqual([
      ["typ JWT", "ok"],
      ["typ application/at+jwt", "ok"],
      ["no typ", "ok"],
      ["typ dpop+jwt", "wrong-token-type"],
      ["fapi2 without typ", "wrong-token-type"],
      ["EdDSA with an Ed25519 key", "ok"],
      ["EdDSA without Ed25519", "alg-not-allowed"],
      ["ES256 not allowed", "alg-not-allowed"],
      ["no kid with two keys", "unknown-kid"],
      ["no kid with one key", "ok"],
    ]);
  });

  it("checks the expected typ list from the call over the option", async () => {
    const token = await sign({}, { typ: "custom+jwt" });
    expect([
      await causeOf(token, { typ: "custom+jwt" }),
      await causeOf(token, { typ: ["other+jwt"] }),
      await causeOf(token, {}, { typ: ["application/custom+jwt"] }),
    ]).toEqual(["ok", "wrong-token-type", "ok"]);
  });

  it("skips undersized RSA and P-192 keys under fapi2", async () => {
    const small = { kty: "RSA", n: "A".repeat(171), e: "AQAB", kid: "es-1" };
    const p192 = { kty: "EC", crv: "P-192", x: "x", y: "y", kid: "es-1" };
    const token = await sign({ cnf: { jkt: "x" } });
    expect([
      await causeOf(token, { profile: "fapi2", jwks: { keys: [small] } }),
      await causeOf(token, { profile: "fapi2", jwks: { keys: [p192] } }),
      await causeOf(token, {
        profile: "fapi2",
        jwks: { keys: [p192, es.jwk] },
      }),
    ]).toEqual(["unknown-kid", "unknown-kid", "ok"]);
  });

  it("maps jose failures to causes", async () => {
    const notYet = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setNotBefore(4_000_000_000)
      .setExpirationTime(4_100_000_000)
      .sign(es.private);
    const noExp = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(es.private);
    const notJson = await new CompactSign(new TextEncoder().encode("[1,2]"))
      .setProtectedHeader({ alg: "ES256", kid: "es-1" })
      .sign(es.private);
    const otherKey = await generateKeyPair("ES256");
    const badSignature = await sign({}, {}, otherKey.privateKey);
    expect([
      await causeOf(notYet),
      await causeOf(noExp),
      await causeOf(notJson),
      await causeOf(badSignature),
    ]).toEqual([
      "not-yet-valid",
      "malformed",
      "malformed",
      "invalid-signature",
    ]);
  });

  it("accepts a Security Event Token without exp but with iat", async () => {
    const set = await new SignJWT({ sub: "u1", events: {} })
      .setProtectedHeader({ alg: "ES256", kid: "es-1", typ: "secevent+jwt" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(NOW)
      .sign(es.private);
    expect(await causeOf(set, {}, { typ: "secevent+jwt" })).toBe("ok");
  });

  it("rejects empty, headerless and crit tokens as malformed", async () => {
    const check = verifier();
    const crit = await sign({}, { crit: ["b64"], b64: true });
    const results = await Promise.all(
      ["", ".a.b", "bm90LWpzb24.a.b", crit].map(async (token) => {
        const result = await check.verify(token, {});
        return result.ok ? "ok" : result.cause;
      }),
    );
    expect(results).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
    // SAFETY: a JavaScript caller can pass a non-string token.
    const nonString = await check.verify(42 as unknown as string, {});
    expect(nonString.ok ? "ok" : nonString.cause).toBe("malformed");
  });
});

describe("joseTokenVerifier HMAC secrets", () => {
  const secret = "x".repeat(32);

  it("verifies HS256 only when allowed and only for HS256 headers", async () => {
    const key = new TextEncoder().encode(secret);
    const hs = await sign({}, { alg: "HS256", kid: undefined }, key);
    const es256 = await sign();
    expect([
      await causeOf(hs, { jwks: { secret }, algorithms: ["HS256"] }),
      await causeOf(hs, { jwks: { secret } }),
      await causeOf(es256, { jwks: { secret }, algorithms: ["HS256"] }),
    ]).toEqual(["ok", "alg-not-allowed", "alg-not-allowed"]);
  });
});

describe("joseTokenVerifier nested JWE", () => {
  const secret = new Uint8Array(32).fill(3);
  const k = base64url.encode(secret);

  async function encrypt(
    header: Record<string, unknown>,
    key: Uint8Array = secret,
  ): Promise<string> {
    return new CompactEncrypt(new TextEncoder().encode(await sign()))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", ...header })
      .encrypt(key);
  }

  it("maps every nested JWE path", async () => {
    const withCty = await encrypt({ cty: "JWT" });
    const cases: readonly [
      string,
      string,
      Partial<JoseTokenVerifierOptions>,
    ][] = [
      ["single key object", withCty, { decryptionKeys: { kty: "oct", k } }],
      ["no cty", await encrypt({}), { decryptionKeys: { kty: "oct", k } }],
      [
        "zip",
        `${base64url.encode(JSON.stringify({ alg: "dir", enc: "A256GCM", cty: "JWT", zip: "DEF" }))}.a.b.c.d`,
        { decryptionKeys: { kty: "oct", k } },
      ],
      ["non-oct key", withCty, { decryptionKeys: { keys: [{ kty: "RSA" }] } }],
      ["empty key list", withCty, { decryptionKeys: { keys: [] } }],
      [
        "wrong key",
        withCty,
        {
          decryptionKeys: {
            kty: "oct",
            k: base64url.encode(new Uint8Array(32).fill(9)),
          },
        },
      ],
      [
        "algorithm not listed",
        withCty,
        {
          decryptionKeys: { kty: "oct", k },
          decryptionAlgorithms: ["RSA-OAEP-256"],
        },
      ],
    ];
    const results = [];
    for (const [label, token, options] of cases) {
      results.push([label, await causeOf(token, options)]);
    }
    expect(results).toEqual([
      ["single key object", "ok"],
      ["no cty", "encrypted-token"],
      ["zip", "encrypted-token"],
      ["non-oct key", "encrypted-token"],
      ["empty key list", "encrypted-token"],
      ["wrong key", "encrypted-token"],
      ["algorithm not listed", "encrypted-token"],
    ]);
  });

  it("refuses RSA1_5 before decrypting", async () => {
    const header = base64url.encode(
      JSON.stringify({ alg: "RSA1_5", enc: "A256GCM", cty: "JWT" }),
    );
    expect(
      await causeOf(`${header}.a.b.c.d`, { decryptionKeys: { kty: "oct", k } }),
    ).toBe("encrypted-token");
  });
});

describe("remote JWKS cache", () => {
  function jwksResponse(maxAge?: number): Response {
    return json(
      { keys: [es.jwk] },
      200,
      maxAge === undefined
        ? {}
        : { "cache-control": `public, max-age=${String(maxAge)}` },
    );
  }

  it("fetches a URL instance or a string and caches within max-age", async () => {
    for (const jwks of [
      new URL("https://login.test/jwks"),
      "https://login.test/jwks",
    ]) {
      const fake = fakeFetch(() => jwksResponse(120));
      const cache = createKeyCache({ jwks, fetch: fake.fetch });
      expect((await cache.resolveJwks(NOW)).ok).toBe(true);
      expect((await cache.resolveJwks(NOW + 100)).ok).toBe(true);
      expect(fake.calls.length).toBe(1);
      await cache.resolveJwks(NOW + 200);
      expect(fake.calls.length).toBe(2);
    }
  });

  it("defaults to the max ttl without cache-control and ignores a malformed one", async () => {
    for (const reply of [
      () => jwksResponse(),
      () => json({ keys: [es.jwk] }, 200, { "cache-control": "no-store" }),
    ]) {
      const fake = fakeFetch(reply);
      const cache = createKeyCache({
        jwks: "https://login.test/jwks",
        fetch: fake.fetch,
        jwksCache: { maxTtl: 600 },
      });
      await cache.resolveJwks(NOW);
      await cache.resolveJwks(NOW + 599);
      expect(fake.calls.length).toBe(1);
    }
  });

  it("shares one request between concurrent resolves", async () => {
    const fake = fakeFetch(() => jwksResponse(120));
    const cache = createKeyCache({
      jwks: "https://login.test/jwks",
      fetch: fake.fetch,
    });
    const results = await Promise.all([
      cache.resolveJwks(NOW),
      cache.resolveJwks(NOW),
      cache.refetchJwks(NOW),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  it("gives up on a JWKS endpoint that does not answer within the timeout", async () => {
    const hanging = (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted", { cause: init.signal?.reason }));
        });
      });
    const cache = createKeyCache({
      jwks: "https://login.test/jwks",
      // SAFETY: hanging has fetch's call signature; preconnect is never called.
      fetch: hanging as typeof fetch,
      jwksCache: { timeout: 20 },
    });
    expect(await cache.resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "jwks-unavailable",
    });
  });

  it("serves a cached set when a later fetch fails and reports unavailability otherwise", async () => {
    let healthy = true;
    const fake = fakeFetch(() => (healthy ? jwksResponse(120) : json({}, 500)));
    const cache = createKeyCache({
      jwks: "https://login.test/jwks",
      fetch: fake.fetch,
    });
    await cache.resolveJwks(NOW);
    healthy = false;
    expect((await cache.refetchJwks(NOW + 10)).ok).toBe(true);
    expect(await cache.resolveJwks(NOW + 500)).toEqual({
      ok: false,
      cause: "jwks-unavailable",
    });
  });

  it("rejects an empty key set", async () => {
    const cache = createKeyCache({
      jwks: "https://login.test/jwks",
      fetch: fakeFetch(() => json({ keys: [] })).fetch,
    });
    expect(await cache.resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "jwks-unavailable",
    });
  });

  it("refetches once per cooldown", async () => {
    const fake = fakeFetch(() => jwksResponse(3600));
    const cache = createKeyCache({
      jwks: "https://login.test/jwks",
      fetch: fake.fetch,
      jwksCache: { cooldown: 30 },
    });
    await cache.resolveJwks(NOW);
    await cache.refetchJwks(NOW + 1);
    await cache.refetchJwks(NOW + 2);
    expect(fake.calls.length).toBe(2);
    await cache.refetchJwks(NOW + 40);
    expect(fake.calls.length).toBe(3);
  });

  it("is unavailable without jwks or discovery", async () => {
    expect(await createKeyCache({}).resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "jwks-unavailable",
    });
  });

  it("refetches through the verifier on an unknown kid", async () => {
    let rotated = false;
    const fake = fakeFetch(() =>
      json({ keys: rotated ? [es.jwk] : [{ ...es.jwk, kid: "old" }] }),
    );
    const check = joseTokenVerifier({
      jwks: "https://login.test/jwks",
      issuer: ISSUER,
      fetch: fake.fetch,
    });
    rotated = false;
    const first = await check.verify(await sign(), {});
    expect(first.ok ? "ok" : first.cause).toBe("unknown-kid");
    rotated = true;
    const unavailable = joseTokenVerifier({
      jwks: "https://login.test/jwks",
      issuer: ISSUER,
      fetch: fakeFetch(() => json({}, 503)).fetch,
    });
    const failed = await unavailable.verify(await sign(), {});
    expect(failed.ok ? "ok" : failed.cause).toBe("jwks-unavailable");
  });
});

describe("discovery", () => {
  function discoveryFetch(
    documents: Readonly<Record<string, unknown>>,
  ): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      if (call.url.endsWith("/jwks")) {
        return json({ keys: [es.jwk] });
      }
      const document = documents[call.url];
      return document === undefined
        ? undefined
        : json(document, 200, { "cache-control": "max-age=300" });
    });
  }

  it("reads OIDC discovery under an issuer path", async () => {
    const issuer = "https://login.test/tenant/";
    const fake = discoveryFetch({
      "https://login.test/tenant/.well-known/openid-configuration": {
        issuer,
        jwks_uri: "https://login.test/jwks",
      },
    });
    const cache = createKeyCache({ discovery: issuer, fetch: fake.fetch });
    expect((await cache.resolveJwks(NOW)).ok).toBe(true);
    expect((await cache.resolveJwks(NOW + 10)).ok).toBe(true);
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://login.test/tenant/.well-known/openid-configuration",
      "https://login.test/jwks",
    ]);
  });

  it("falls back to RFC 8414 metadata", async () => {
    const issuer = "https://login.test/tenant";
    const fake = discoveryFetch({
      "https://login.test/.well-known/oauth-authorization-server/tenant": {
        issuer,
        jwks_uri: "https://login.test/jwks",
      },
    });
    const cache = createKeyCache({ discovery: issuer, fetch: fake.fetch });
    expect((await cache.resolveJwks(NOW)).ok).toBe(true);
  });

  it("reports a mismatched issuer and an http jwks_uri", async () => {
    const mismatch = createKeyCache({
      discovery: ISSUER,
      fetch: discoveryFetch({
        "https://login.test/.well-known/openid-configuration": {
          issuer: "https://evil.test",
          jwks_uri: "https://login.test/jwks",
        },
      }).fetch,
    });
    expect(await mismatch.resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "discovery-mismatch",
    });
    const insecure = createKeyCache({
      discovery: ISSUER,
      fetch: discoveryFetch({
        "https://login.test/.well-known/openid-configuration": {
          issuer: ISSUER,
          jwks_uri: "http://login.test/jwks",
        },
      }).fetch,
    });
    expect(await insecure.resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "discovery-unavailable",
    });
  });

  it("serves stale discovery when the issuer goes down", async () => {
    let up = true;
    const fake = fakeFetch((call) => {
      if (call.url.endsWith("/jwks")) {
        return json({ keys: [es.jwk] });
      }
      if (!up) {
        throw new Error("down");
      }
      return json({ issuer: ISSUER, jwks_uri: "https://login.test/jwks" });
    });
    const cache = createKeyCache({
      discovery: ISSUER,
      fetch: fake.fetch,
      jwksCache: { minTtl: 60, maxTtl: 60 },
    });
    await cache.resolveJwks(NOW);
    up = false;
    expect((await cache.resolveJwks(NOW + 120)).ok).toBe(true);
  });

  it("uses inline metadata and checks its issuer", async () => {
    const fake = discoveryFetch({});
    const ok = createKeyCache({
      discovery: {
        issuer: ISSUER,
        metadata: { issuer: ISSUER, jwks_uri: "https://login.test/jwks" },
      },
      fetch: fake.fetch,
    });
    expect((await ok.resolveJwks(NOW)).ok).toBe(true);
    const bad = createKeyCache({
      discovery: {
        issuer: ISSUER,
        metadata: {
          issuer: "https://evil.test",
          jwks_uri: "https://login.test/jwks",
        },
      },
      fetch: fake.fetch,
    });
    expect(await bad.resolveJwks(NOW)).toEqual({
      ok: false,
      cause: "discovery-mismatch",
    });
  });
});

describe("configuration", () => {
  it("rejects unsafe or contradictory setup", () => {
    const cases: readonly [
      string,
      Parameters<typeof assertSubjectConfig>[0],
    ][] = [
      ["relative jwks", { jwks: "jwks.json", issuer: ISSUER }],
      ["non-URL discovery", { discovery: "login" }],
      ["http discovery", { discovery: "http://login.test" }],
      ["issuer mismatch", { discovery: ISSUER, issuer: "https://other.test" }],
      [
        "http jwks_uri",
        {
          discovery: {
            issuer: ISSUER,
            metadata: { jwks_uri: "http://login.test/jwks" },
          },
        },
      ],
      ["short HMAC secret", { jwks: { secret: new Uint8Array(8) } }],
      [
        "alg none",
        {
          jwks: { keys: [] },
          issuer: ISSUER,
          // SAFETY: a JavaScript caller can list 'none'; the check exists for it.
          algorithms: ["none" as "ES256"],
        },
      ],
      [
        "forbidden assurance path",
        {
          jwks: { keys: [] },
          issuer: ISSUER,
          claims: { assurance: "__proto__" },
        },
      ],
      [
        "forbidden nested assurance path",
        {
          jwks: { keys: [] },
          issuer: ISSUER,
          claims: { assurance: { acr: "a", amr: "constructor.x" } },
        },
      ],
      [
        "forbidden kind path",
        { jwks: { keys: [] }, issuer: ISSUER, claims: { kind: "prototype" } },
      ],
    ];
    for (const [label, options] of cases) {
      expect({
        label,
        throws: throws(() => assertSubjectConfig(options)),
      }).toEqual({
        label,
        throws: true,
      });
    }
  });

  it("accepts literal kinds and safe assurance paths", () => {
    expect(
      throws(() =>
        assertSubjectConfig({
          jwks: { keys: [] },
          issuer: ISSUER,
          claims: { kind: "workload", assurance: { verified: "vc" } },
        }),
      ),
    ).toBe(false);
  });
});

describe("header helpers", () => {
  it("decodes only object headers and normalises typ", () => {
    const encode = (value: unknown): string =>
      `${base64url.encode(JSON.stringify(value))}.p.s`;
    expect([
      decodeHeader(encode(["a"])),
      decodeHeader(encode(null)),
      decodeHeader(encode({ alg: "ES256" })),
    ]).toEqual([undefined, undefined, { alg: "ES256" }]);
    expect([
      normalizeTyp(undefined),
      normalizeTyp("Application/AT+JWT"),
      normalizeTyp("JWT"),
    ]).toEqual([undefined, "at+jwt", "jwt"]);
    // SAFETY: an unverified header may carry crit as a string.
    const stringCrit = { crit: "alg" } as unknown as Parameters<
      typeof unknownCrit
    >[0];
    expect([
      unknownCrit({}),
      unknownCrit(stringCrit),
      unknownCrit({ crit: ["alg", "kid"] }),
      unknownCrit({ crit: ["exp"] }),
    ]).toEqual([false, true, false, true]);
  });

  it("imports keys as jose would", async () => {
    expect(await importJWK(es.jwk, "ES256")).toBeDefined();
  });
});

function throws(run: () => void): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}
