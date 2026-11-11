import { resolveAuth, purgeKeys } from "better-supabase/server";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { createKeyCache } from "../../src/jwt/cache.ts";
import { SUPABASE_JWKS_MAX_TTL } from "../../src/jwt/config.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";

const PROJECT = "https://abc.supabase.co";
const JWKS = `${PROJECT}/auth/v1/.well-known/jwks.json`;
const ISSUER = `${PROJECT}/auth/v1`;
const START = 1_800_000_000;

/** Seconds after the first fetch at which both caches are asked again. */
const OFFSETS = [0, 299, 300, 599, 600, 601, 900] as const;

let key: { readonly private: CryptoKey; readonly jwk: Record<string, unknown> };

/**
 * A key set the issuer says may be cached for a day, then an issuer that is
 * down.
 */
function issuer(): {
  readonly fetch: typeof fetch;
  readonly calls: () => number;
  readonly fail: () => void;
} {
  let down = false;
  const fake = fakeFetch(() =>
    down
      ? new Response("", { status: 503 })
      : json({ keys: [key.jwk] }, 200, {
          "cache-control": "public, max-age=86400",
        }),
  );
  return {
    fetch: fake.fetch,
    calls: () => fake.calls.length,
    fail: () => {
      down = true;
    },
  };
}

async function token(): Promise<string> {
  return new SignJWT({ sub: "u1", role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt(START)
    .setExpirationTime(START + 86_400)
    .sign(key.private);
}

/**
 * Whether better-supabase still verifies a token `offset` seconds after the
 * first fetch.
 */
async function betterSupabaseServes(
  signed: string,
  fetcher: typeof fetch,
  offset: number,
): Promise<boolean> {
  const resolution = await resolveAuth(
    new Request(`${PROJECT}/rest`, {
      headers: { authorization: `Bearer ${signed}` },
    }),
    {
      env: {
        url: PROJECT,
        publishableKey: "sb_publishable_test",
        jwksUrl: new URL(JWKS),
      },
      cookies: false,
      fetch: fetcher,
      now: () => (START + offset) * 1000,
    },
  );
  return resolution.auth.kind === "user";
}

describe("Supabase key window, PermDock against better-supabase", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    key = {
      private: pair.privateKey,
      jwk: { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" },
    };
  });

  it("serves a Supabase key set for at most 600 seconds after its fetch, stale serving included", async () => {
    expect(SUPABASE_JWKS_MAX_TTL).toBe(600);
    const signed = await token();
    const ours: boolean[] = [];
    const theirs: boolean[] = [];
    for (const offset of OFFSETS) {
      const permdock = issuer();
      const cache = createKeyCache({
        jwks: JWKS,
        fetch: permdock.fetch,
        jwksCache: { maxTtl: 7200 },
      });
      const bsb = issuer();
      expect((await cache.resolveJwks(START)).ok).toBe(true);
      expect(await betterSupabaseServes(signed, bsb.fetch, 0)).toBe(true);
      permdock.fail();
      bsb.fail();
      const resolved = await cache.resolveJwks(START + offset);
      const refetched = await cache.refetchJwks(START + offset);
      ours.push(resolved.ok && refetched.ok);
      theirs.push(await betterSupabaseServes(signed, bsb.fetch, offset));
    }
    const expected = OFFSETS.map((offset) => offset < 600);
    expect(ours).toStrictEqual(expected);
    expect(theirs).toStrictEqual(expected);
  });

  it("fetches again on the next verification after purgeKeys, like better-supabase's purgeKeys", async () => {
    const signed = await token();
    const permdock = issuer();
    const verifier = joseTokenVerifier({
      jwks: JWKS,
      issuer: ISSUER,
      audience: "authenticated",
      fetch: permdock.fetch,
    });
    expect((await verifier.verify(signed, {})).ok).toBe(true);
    expect((await verifier.verify(signed, {})).ok).toBe(true);
    expect(permdock.calls()).toBe(1);
    verifier.purgeKeys();
    expect((await verifier.verify(signed, {})).ok).toBe(true);
    expect(permdock.calls()).toBe(2);

    const bsb = issuer();
    expect(await betterSupabaseServes(signed, bsb.fetch, 0)).toBe(true);
    expect(await betterSupabaseServes(signed, bsb.fetch, 1)).toBe(true);
    expect(bsb.calls()).toBe(1);
    purgeKeys(JWKS);
    expect(await betterSupabaseServes(signed, bsb.fetch, 2)).toBe(true);
    expect(bsb.calls()).toBe(2);
  });

  it("keeps no key cache on the better-supabase authorizer path", () => {
    // The authorizer reads claims better-supabase already verified, so a second
    // cache could only keep a revoked key verifying after better-supabase dropped it.
    const folder = new URL("../../src/better-supabase/", import.meta.url);
    const imports = readdirSync(folder)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [
          ...readFileSync(new URL(file, folder), "utf8").matchAll(
            /from\s+"([^"]+)"/gu,
          ),
        ].map((match) => match[1] ?? ""),
      );
    expect(
      imports.filter((path) => /\/jwt\/|^jose$/u.test(path)),
    ).toStrictEqual([]);
  });
});
