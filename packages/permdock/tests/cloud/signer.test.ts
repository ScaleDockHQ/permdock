import { describe, expect, it } from "vitest";

import { cloudSigner } from "../../src/cloud/signer.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const CLOUD_URL = "https://cloud.permdock.test";
const CLOUD_ENV = `${CLOUD_URL}/v1/environments/production`;
const KEY = "env-key";
const AUDIENCE = "https://app.example.com";

const kms = joseTokenSigner({
  key: { ...PRIVATE_JWK },
  alg: "Ed25519",
  kid: "2026-09",
  issuer: CLOUD_ENV,
});

type SignBody = {
  readonly typ: Parameters<typeof kms.sign>[1]["typ"];
  readonly claims: Record<string, unknown>;
  readonly aud: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly jti?: string;
};

function fakeCloud(
  options: { readonly status?: number; readonly token?: string } = {},
): { readonly fetch: typeof fetch; readonly signed: SignBody[] } {
  const signed: SignBody[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/.well-known/jwks.json")) {
      return Response.json({ keys: [PUBLIC_JWK] });
    }
    expect(`${url.origin}${url.pathname}`).toBe(`${CLOUD_ENV}/sign`);
    expect(request.headers.get("accept")).toBe("application/jwt");
    // SAFETY: cloudSigner under test posts this shape.
    const body = (await request.json()) as SignBody;
    signed.push(body);
    if (options.status !== undefined) {
      return new Response(null, { status: options.status });
    }
    const token =
      options.token ??
      (await kms.sign(body.claims, {
        typ: body.typ,
        audience: body.aud,
        ...(body.exp === undefined ? {} : { expiresAt: body.exp }),
        ...(body.iat === undefined ? {} : { issuedAt: body.iat }),
        ...(body.jti === undefined ? {} : { jti: body.jti }),
      }));
    return new Response(token, {
      headers: { "content-type": "application/jwt" },
    });
  };
  return { fetch: fetchImpl, signed };
}

describe("cloudSigner", () => {
  it("signs a run ticket with the environment's key", async () => {
    const fake = fakeCloud();
    const signer = cloudSigner({
      url: CLOUD_URL,
      key: KEY,
      audience: AUDIENCE,
      fetch: fake.fetch,
    });
    const token = await signer.sign(
      { sub: "run_1", iss: "https://forged.example", run: { id: "run_1" } },
      { typ: "vnd.permdock.run+jwt", jti: "run_1" },
    );
    expect(fake.signed).toEqual([
      {
        typ: "vnd.permdock.run+jwt",
        claims: { sub: "run_1", run: { id: "run_1" } },
        aud: AUDIENCE,
        jti: "run_1",
      },
    ]);
    const verifier = joseTokenVerifier({
      jwks: (await signer.jwks?.()) ?? { keys: [] },
      algorithms: ["Ed25519"],
    });
    const verified = await verifier.verify(token, {
      typ: "vnd.permdock.run+jwt",
      audience: AUDIENCE,
      issuer: CLOUD_ENV,
    });
    expect(verified).toMatchObject({
      ok: true,
      claims: { sub: "run_1", jti: "run_1", iss: CLOUD_ENV },
    });
  });

  it("refuses the Cloud's own token types and a missing audience without calling the Cloud", async () => {
    const fake = fakeCloud();
    const signer = cloudSigner({ url: CLOUD_URL, key: KEY, fetch: fake.fetch });
    for (const typ of [
      "vnd.permdock.policy+jwt",
      "vnd.permdock.snapshot+jwt",
      "vnd.permdock.evidence+jwt",
    ] as const) {
      await expect(
        signer.sign({}, { typ, audience: AUDIENCE }),
      ).rejects.toThrow(`never signs ${typ}`);
    }
    await expect(
      signer.sign({}, { typ: "vnd.permdock.run+jwt" }),
    ).rejects.toThrow(/requires an audience/);
    expect(fake.signed).toEqual([]);
  });

  it("throws when the Cloud refuses or returns a token of another type", async () => {
    const refused = cloudSigner({
      url: CLOUD_URL,
      key: KEY,
      audience: AUDIENCE,
      fetch: fakeCloud({ status: 403 }).fetch,
    });
    await expect(
      refused.sign({}, { typ: "vnd.permdock.run+jwt" }),
    ).rejects.toThrow(/HTTP 403/);

    const evidence = await kms.sign(
      {},
      { typ: "vnd.permdock.evidence+jwt", audience: AUDIENCE },
    );
    for (const token of [evidence, "not-a-jws"]) {
      const wrong = cloudSigner({
        url: CLOUD_URL,
        key: KEY,
        audience: AUDIENCE,
        fetch: fakeCloud({ token }).fetch,
      });
      await expect(
        wrong.sign({}, { typ: "vnd.permdock.run+jwt" }),
      ).rejects.toThrow(/not a vnd\.permdock\.run\+jwt JWS/);
    }
  });

  it("returns no keys when the key set is unreachable", async () => {
    const signer = cloudSigner({
      url: CLOUD_URL,
      key: KEY,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await signer.jwks?.()).toEqual({ keys: [] });
  });
});
