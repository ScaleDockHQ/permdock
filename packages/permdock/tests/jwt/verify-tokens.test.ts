import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { TokenVerifier } from "../../src/core/interfaces.ts";

import {
  joseTokenVerifier,
  memoryReplayStore,
  verifyIdToken,
  verifySubjectToken,
} from "../../src/jwt/index.ts";

const ENV = "https://cloud.example.com/v1/environments/prod";
const BYO = "https://app.example.com";
const OP = "https://login.example.com";
const CLIENT = "web-app";
const NOW = Math.floor(Date.now() / 1000);

type Key = {
  readonly kid: string;
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
};
const env: Key = { kid: "env-1", privateJwk: {}, publicJwk: {} };
const byo: Key = { kid: "byo-1", privateJwk: {}, publicJwk: {} };
const op: Key = { kid: "op-1", privateJwk: {}, publicJwk: {} };

beforeAll(async () => {
  for (const key of [env, byo, op]) {
    const pair = await generateKeyPair("ES256", { extractable: true });
    key.privateJwk = { ...(await exportJWK(pair.privateKey)), kid: key.kid };
    key.publicJwk = { ...(await exportJWK(pair.publicKey)), kid: key.kid };
  }
});

async function sign(
  key: Key,
  claims: Record<string, unknown>,
  options: {
    readonly typ?: string | null;
    readonly issuer: string;
    readonly audience: string | string[];
    readonly lifetime?: number;
    readonly iat?: boolean;
  },
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: "ES256",
      kid: key.kid,
      ...(options.typ === null ? {} : { typ: options.typ ?? "at+jwt" }),
    })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setExpirationTime(NOW + (options.lifetime ?? 300));
  if (options.iat !== false) {
    jwt.setIssuedAt(NOW);
  }
  return jwt.sign(await importJWK(key.privateJwk, "ES256"));
}

describe("verifySubjectToken", () => {
  const verifiers = (): TokenVerifier[] => [
    joseTokenVerifier({ jwks: { keys: [env.publicJwk] }, issuer: ENV }),
    joseTokenVerifier({ jwks: { keys: [byo.publicJwk] }, issuer: BYO }),
  ];
  const subjectToken = (
    key: Key,
    issuer: string,
    claims: Record<string, unknown> = {},
    options: { readonly typ?: string; readonly lifetime?: number } = {},
  ): Promise<string> =>
    sign(
      key,
      { sub: "u_1", jti: crypto.randomUUID(), ...claims },
      { issuer, audience: ENV, ...options },
    );

  it("accepts a token from any listed issuer once", async () => {
    const replay = memoryReplayStore();
    for (const [key, issuer] of [
      [env, ENV],
      [byo, BYO],
    ] as const) {
      const token = await subjectToken(key, issuer);
      const options = { verifiers: verifiers(), audience: ENV, replay };
      const first = await verifySubjectToken(token, options);
      expect(first).toMatchObject({
        ok: true,
        claims: { iss: issuer, sub: "u_1" },
        header: { typ: "at+jwt" },
      });
      expect(await verifySubjectToken(token, options)).toEqual({
        ok: false,
        cause: "replayed",
      });
    }
  });

  it.each<[string, () => Promise<string>, string]>([
    [
      "a lifetime over five minutes",
      () => subjectToken(env, ENV, {}, { lifetime: 301 }),
      "lifetime-exceeded",
    ],
    [
      "a token without jti",
      () => subjectToken(env, ENV, { jti: undefined }),
      "malformed",
    ],
    [
      "a token without sub",
      () => subjectToken(env, ENV, { sub: undefined }),
      "malformed",
    ],
    [
      "an ID token",
      () => subjectToken(env, ENV, {}, { typ: "JWT" }),
      "wrong-token-type",
    ],
    ["an unknown issuer", () => subjectToken(op, OP), "unknown-kid"],
    [
      "a token for another audience",
      () =>
        sign(
          env,
          { sub: "u_1", jti: "j" },
          { issuer: ENV, audience: "https://elsewhere.example" },
        ),
      "wrong-audience",
    ],
  ])("refuses %s", async (_label, make, cause) => {
    expect(
      await verifySubjectToken(await make(), {
        verifiers: verifiers(),
        audience: ENV,
        replay: memoryReplayStore(),
      }),
    ).toEqual({ ok: false, cause });
  });

  it("honours maxLifetime and refuses when the replay store throws", async () => {
    const token = await subjectToken(env, ENV, {}, { lifetime: 600 });
    expect(
      await verifySubjectToken(token, {
        verifiers: verifiers(),
        audience: ENV,
        replay: memoryReplayStore(),
        maxLifetime: 600,
      }),
    ).toMatchObject({ ok: true });
    const throwing = {
      seen: () => {
        throw new Error("down");
      },
      remember: () => undefined,
    };
    expect(
      await verifySubjectToken(await subjectToken(env, ENV), {
        verifiers: verifiers(),
        audience: ENV,
        replay: throwing,
      }),
    ).toEqual({ ok: false, cause: "replayed" });
  });

  it("treats a throwing verifier as a refusal and tries the next", async () => {
    const throwing: TokenVerifier = {
      verify: () => Promise.reject(new Error("boom")),
    };
    const token = await subjectToken(env, ENV);
    expect(
      await verifySubjectToken(token, {
        verifiers: [throwing, ...verifiers()],
        audience: ENV,
        replay: memoryReplayStore(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await verifySubjectToken(token, {
        verifiers: [throwing],
        audience: ENV,
        replay: memoryReplayStore(),
      }),
    ).toEqual({ ok: false, cause: "invalid-signature" });
  });
});

describe("verifyIdToken", () => {
  const idToken = (
    claims: Record<string, unknown> = {},
    options: {
      readonly typ?: string | null;
      readonly audience?: string | string[];
      readonly issuer?: string;
      readonly iat?: boolean;
    } = {},
  ): Promise<string> =>
    sign(
      op,
      { sub: "u_1", nonce: "n-1", ...claims },
      {
        typ: options.typ === undefined ? "JWT" : options.typ,
        issuer: options.issuer ?? OP,
        audience: options.audience ?? CLIENT,
        ...(options.iat === undefined ? {} : { iat: options.iat }),
      },
    );
  const verify = (
    token: string,
    nonce: string | null = "n-1",
  ): ReturnType<typeof verifyIdToken> =>
    verifyIdToken(token, {
      issuer: OP,
      clientId: CLIENT,
      jwks: { keys: [op.publicJwk] },
      ...(nonce === null ? {} : { nonce }),
    });

  it("accepts an ID token with typ JWT or no typ and the expected nonce", async () => {
    expect(await verify(await idToken())).toMatchObject({
      ok: true,
      claims: { iss: OP, sub: "u_1", nonce: "n-1" },
    });
    expect(await verify(await idToken({}, { typ: null }))).toMatchObject({
      ok: true,
    });
    expect(
      await verify(await idToken({ nonce: undefined }), null),
    ).toMatchObject({ ok: true });
  });

  it("accepts azp naming the client with several audiences", async () => {
    expect(
      await verify(
        await idToken({ azp: CLIENT }, { audience: [CLIENT, "other"] }),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each<[string, () => Promise<string>, string]>([
    ["another nonce", () => idToken({ nonce: "n-2" }), "nonce-mismatch"],
    ["no nonce", () => idToken({ nonce: undefined }), "nonce-mismatch"],
    [
      "an access token",
      () => idToken({}, { typ: "at+jwt" }),
      "wrong-token-type",
    ],
    ["no iat", () => idToken({}, { iat: false }), "wrong-token-type"],
    [
      "several audiences without azp",
      () => idToken({}, { audience: [CLIENT, "other"] }),
      "wrong-token-type",
    ],
    [
      "azp naming another client",
      () => idToken({ azp: "other" }, { audience: [CLIENT, "other"] }),
      "wrong-token-type",
    ],
    [
      "another audience",
      () => idToken({}, { audience: "other" }),
      "wrong-audience",
    ],
    ["another issuer", () => idToken({}, { issuer: BYO }), "wrong-issuer"],
  ])("refuses %s", async (_label, make, cause) => {
    expect(await verify(await make())).toEqual({ ok: false, cause });
  });

  it("checks iss itself when a custom verifier skips it", async () => {
    const lax: TokenVerifier = {
      verify: async (token) =>
        joseTokenVerifier({ jwks: { keys: [op.publicJwk] } }).verify(token, {
          audience: CLIENT,
        }),
    };
    expect(
      await verifyIdToken(await idToken({}, { issuer: BYO }), {
        issuer: OP,
        clientId: CLIENT,
        verifier: lax,
      }),
    ).toEqual({ ok: false, cause: "wrong-issuer" });
  });
});
