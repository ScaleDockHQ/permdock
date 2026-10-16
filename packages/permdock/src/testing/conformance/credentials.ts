import { expect, it, vi } from "vitest";

import type { ReplayStore } from "../../ssf/index.ts";

import { nowMillis, nowSeconds } from "../../core/time.ts";
import {
  type CredentialVerifier,
  type RevocationEvent,
  type RevocationFeed,
  type TokenSigner,
  type TokenVerifier,
  parseCredential,
} from "../../index.ts";
import { parseApiKey } from "../../server/credentials.ts";
import {
  jwtFixtureAudience,
  jwtFixtureIssuer,
  jwtFixtureTokens,
} from "../jwt-fixtures.ts";

export function testReplayStore(store: ReplayStore): void {
  it("records a jti after remember and reports it as seen", async () => {
    const jti = "jti-1";
    expect(await store.seen(jti)).toBe(false);
    await store.remember(jti);
    expect(await store.seen(jti)).toBe(true);
    expect(await store.seen("jti-2")).toBe(false);
  });

  it("forgets a jti whose expiresAt has passed", async () => {
    await store.remember("ttl-jti", nowSeconds() - 1);
    expect(await store.seen("ttl-jti")).toBe(false);
  });

  it("claims a key once under concurrency and releases it for a retry", async (context) => {
    if (store.claim === undefined || store.release === undefined) {
      context.skip();
      return;
    }
    const expiresAt = nowSeconds() + 60;
    const results = await Promise.all([
      store.claim("claim-key", expiresAt),
      store.claim("claim-key", expiresAt),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
    expect(await store.seen("claim-key")).toBe(true);
    await store.release("claim-key");
    expect(await store.claim("claim-key", expiresAt)).toBe(true);
  });
}

export function testRevocationFeed(feed: RevocationFeed): void {
  it("delivers each event to every subscriber until it unsubscribes", async () => {
    const first: RevocationEvent[] = [];
    const second: RevocationEvent[] = [];
    const stopFirst = feed.subscribe((event) => {
      first.push(event);
    });
    const stopSecond = feed.subscribe((event) => {
      second.push(event);
    });
    const revoked: RevocationEvent = {
      principal: "u-feed",
      session: "s-feed",
      kind: "session-revoked",
    };
    await feed.revoke(revoked);
    await vi.waitFor(() => {
      expect(first).toEqual([revoked]);
      expect(second).toEqual([revoked]);
    });
    stopFirst();
    const changed: RevocationEvent = {
      principal: "u-feed",
      tenant: "t-feed",
      kind: "changed",
    };
    await feed.revoke(changed);
    await vi.waitFor(() => {
      expect(second).toEqual([revoked, changed]);
    });
    expect(first).toEqual([revoked]);
    stopSecond();
  });

  it("keeps delivering when a listener throws", async () => {
    const seen: RevocationEvent[] = [];
    const stopThrowing = feed.subscribe(() => {
      throw new Error("listener failed");
    });
    const stop = feed.subscribe((event) => {
      seen.push(event);
    });
    const event: RevocationEvent = { principal: "u-throw", kind: "changed" };
    await feed.revoke(event);
    await vi.waitFor(() => {
      expect(seen).toEqual([event]);
    });
    stopThrowing();
    stop();
  });

  it("rejects an event without a principal or with an unknown kind", async () => {
    const seen: unknown[] = [];
    const stop = feed.subscribe((event) => {
      seen.push(event);
    });
    // SAFETY: deliberately malformed events to exercise the feed's fail-closed validation.
    const bad = [
      { principal: "", kind: "changed" },
      { principal: "u-bad", kind: "granted" },
    ] as unknown as readonly RevocationEvent[];
    for (const event of bad) {
      await expect(
        (async (): Promise<void> => {
          await feed.revoke(event);
        })(),
      ).rejects.toThrow(TypeError);
    }
    expect(seen).toEqual([]);
    stop();
  });
}

function decodeHeader(token: string): Record<string, unknown> {
  const [encoded] = token.split(".");
  if (encoded === undefined) {
    return {};
  }
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  // SAFETY: the protected header of a JWS the signer under test produced is a JSON object.
  return JSON.parse(atob(`${padded}${pad}`)) as Record<string, unknown>;
}

export function testTokenVerifier(
  verifier: TokenVerifier,
  options?: { readonly audience?: string; readonly issuer?: string },
): void {
  const audience = options?.audience ?? jwtFixtureAudience;
  const issuer = options?.issuer ?? jwtFixtureIssuer;
  it("never throws and maps the JWT behaviour table", async () => {
    const valid = await verifier.verify(jwtFixtureTokens.valid, {
      audience,
      issuer,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.claims.sub).toBe("u_1");
      expect(valid.header.alg).toBe("Ed25519");
    }
    const rows: readonly {
      readonly token: string;
      readonly cause: string;
    }[] = [
      { token: jwtFixtureTokens.none, cause: "alg-none" },
      { token: jwtFixtureTokens.expired, cause: "expired" },
      { token: jwtFixtureTokens.wrongAud, cause: "wrong-audience" },
      { token: jwtFixtureTokens.wrongIss, cause: "wrong-issuer" },
      { token: jwtFixtureTokens.unknownKid, cause: "unknown-kid" },
      { token: "not-a-jwt", cause: "malformed" },
      { token: "a.b.c.d.e", cause: "encrypted-token" },
    ];
    for (const row of rows) {
      let result: Awaited<ReturnType<TokenVerifier["verify"]>>;
      try {
        result = await verifier.verify(row.token, { audience, issuer });
      } catch {
        throw new Error("TokenVerifier must not throw");
      }
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe(row.cause);
      }
    }
  });
}

function flipLast(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

/**
 * `key` is a live key the verifier knows, or a function issuing one (called
 * once). `revoke`, when given, revokes it; the runner then expects the key
 * to stop verifying.
 */
export function testCredentialVerifier(
  verifier: CredentialVerifier,
  options: {
    readonly key: string | (() => string | Promise<string>);
    readonly revoke?: () => void | Promise<void>;
  },
): void {
  let issued: Promise<string> | undefined;
  const live = (): Promise<string> => {
    const source = options.key;
    issued ??= Promise.resolve(typeof source === "string" ? source : source());
    return issued;
  };

  it("verifies the live key to a v1 credential with the key id", async () => {
    const key = await live();
    const parts = parseApiKey(key);
    expect(parts).toBeDefined();
    const credential = parseCredential(await verifier.verify(key));
    expect(credential).toBeDefined();
    expect(credential?.id).toBe(parts?.id);
    expect(parseCredential(await verifier.verify(key))).toEqual(credential);
  });

  it("never throws and answers null for every other key", async () => {
    const key = await live();
    const parts = parseApiKey(key);
    const others = [
      "",
      "garbage",
      "pdk_",
      `${key}x`,
      flipLast(key),
      `pdk_${parts?.id ?? "x"}-other_${parts?.secret ?? ""}`,
      key.replace(/^pdk_/u, "sk_"),
    ];
    for (const other of others) {
      let result: Awaited<ReturnType<CredentialVerifier["verify"]>>;
      try {
        result = await verifier.verify(other);
      } catch {
        throw new Error("CredentialVerifier must not throw");
      }
      expect(result).toBeNull();
    }
  });

  if (verifier.touch !== undefined) {
    it("accepts a touch without changing what the key verifies to", async () => {
      const key = await live();
      const before = parseCredential(await verifier.verify(key));
      const id = parseApiKey(key)?.id ?? "";
      await verifier.touch?.(id, { epochMilliseconds: nowMillis() });
      await verifier.touch?.("unknown-id", { epochMilliseconds: nowMillis() });
      expect(parseCredential(await verifier.verify(key))).toEqual(before);
    });
  }

  if (options.revoke !== undefined) {
    const revoke = options.revoke;
    it("stops verifying a revoked key", async () => {
      const key = await live();
      await revoke();
      expect(await verifier.verify(key)).toBeNull();
    });
  }
}

export function testTokenSigner(
  signer: TokenSigner,
  options: { readonly verifier: TokenVerifier },
): void {
  it("emits compact JWS with only alg, kid and typ", async () => {
    const token = await signer.sign(
      { snapshot: { v: 1 }, sub: "u_1" },
      { typ: "vnd.permdock.snapshot+jwt", audience: "https://app.example.com" },
    );
    const header = decodeHeader(token);
    expect(Object.keys(header).toSorted()).toEqual(["alg", "kid", "typ"]);
    expect(header["typ"]).toBe("vnd.permdock.snapshot+jwt");
    expect(header["alg"]).not.toBe("none");
    const verified = await options.verifier.verify(token, {
      typ: "vnd.permdock.snapshot+jwt",
      audience: "https://app.example.com",
    });
    expect(verified.ok).toBe(true);
    if (signer.jwks !== undefined) {
      const jwks = await signer.jwks();
      expect(jwks.keys.length).toBeGreaterThan(0);
      expect(jwks.keys[0]).not.toHaveProperty("d");
    }
  });
}
