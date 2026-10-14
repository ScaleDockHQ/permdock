import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { ReplayStore } from "../../src/ssf/types.ts";

import {
  webhookSigner,
  webhookVerifier,
} from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";
import { standardsFixture } from "./fixtures.ts";

const vector = standardsFixture("standard-webhooks-v1.json");
const sentAt = Temporal.Instant.fromEpochMilliseconds(
  Number(vector.timestamp) * 1000,
);
const at =
  (offset: number): (() => Temporal.Instant) =>
  () =>
    sentAt.add({ seconds: offset });

function headersOf(signature = vector.signature): Record<string, string> {
  return {
    "webhook-id": vector.id,
    "webhook-timestamp": vector.timestamp,
    "webhook-signature": signature,
  };
}

async function ed25519Pair(): Promise<{
  readonly privateJwk: Record<string, string>;
  readonly publicJwk: Record<string, string>;
}> {
  // SAFETY: Ed25519 generateKey returns a key pair.
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // SAFETY: exportKey("jwk") returns a JWK object for an extractable key.
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as Record<string, string>;
  const { d: _d, ...publicJwk } = privateJwk;
  return { privateJwk, publicJwk: { ...publicJwk, kid: "k1" } };
}

describe("Standard Webhooks", () => {
  it("reproduces the reference library's v1 signature", async () => {
    const signer = webhookSigner({
      keys: [{ alg: "v1", secret: vector.secret }],
    });
    expect(
      await signer.sign({ id: vector.id, body: vector.body, now: sentAt }),
    ).toEqual(headersOf());
  });

  it("verifies the reference vector within the five-minute tolerance", async () => {
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay: memoryReplayStore(),
      now: at(299),
    });
    expect(
      await verifier.verify({ headers: headersOf(), body: vector.body }),
    ).toEqual({
      ok: true,
      id: vector.id,
      timestamp: "2021-02-25T15:02:10.000Z",
      body: vector.body,
    });
  });

  it("accepts a secret without the whsec_ prefix and a Request input", async () => {
    const verifier = webhookVerifier({
      secret: vector.secret.slice("whsec_".length),
      replay: memoryReplayStore(),
      now: at(0),
    });
    const request = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers: headersOf(),
      body: vector.body,
    });
    expect((await verifier.verify(request)).ok).toBe(true);
  });

  it("rejects a delivery outside the tolerance either way", async () => {
    for (const offset of [301, -301]) {
      const verifier = webhookVerifier({
        secret: vector.secret,
        replay: memoryReplayStore(),
        now: at(offset),
      });
      expect(
        await verifier.verify({ headers: headersOf(), body: vector.body }),
      ).toEqual({ ok: false, cause: "timestamp-out-of-range" });
    }
  });

  it("requires webhook-id deduplication", async () => {
    const now = Temporal.Now.instant();
    const signer = webhookSigner({
      keys: [{ alg: "v1", secret: vector.secret }],
    });
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay: memoryReplayStore(),
      now: () => now,
    });
    const input = {
      headers: await signer.sign({ id: vector.id, body: vector.body, now }),
      body: vector.body,
    };
    expect((await verifier.verify(input)).ok).toBe(true);
    expect(await verifier.verify(input)).toEqual({
      ok: false,
      cause: "replayed",
    });
  });

  it("deduplicates through a store without claim and fails closed when it throws", async () => {
    const keys = new Set<string>();
    const plain: ReplayStore = {
      seen: (key) => keys.has(key),
      remember: (key) => {
        keys.add(key);
      },
    };
    const input = { headers: headersOf(), body: vector.body };
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay: plain,
      now: at(0),
    });
    expect((await verifier.verify(input)).ok).toBe(true);
    expect([...keys]).toEqual([`webhook:${vector.id}`]);
    expect((await verifier.verify(input)).ok).toBe(false);
    const broken = webhookVerifier({
      secret: vector.secret,
      replay: {
        seen: () => {
          throw new Error("down");
        },
        remember: () => undefined,
      },
      now: at(0),
    });
    expect(await broken.verify(input)).toEqual({
      ok: false,
      cause: "replayed",
    });
  });

  it("does not record an id whose signature fails", async () => {
    const replay = memoryReplayStore();
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay,
      now: at(0),
    });
    const tampered = { headers: headersOf(), body: `${vector.body} ` };
    expect(await verifier.verify(tampered)).toEqual({
      ok: false,
      cause: "invalid-signature",
    });
    expect(await replay.seen(`webhook:${vector.id}`)).toBe(false);
  });

  it("checks every signature in the header and ignores unknown versions", async () => {
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay: memoryReplayStore(),
      now: at(0),
    });
    const other = `v1,${btoa("x".repeat(32))}`;
    expect(
      (
        await verifier.verify({
          headers: headersOf(`v2,abc ${other} ${vector.signature}`),
          body: vector.body,
        })
      ).ok,
    ).toBe(true);
  });

  it.each([
    ["missing-headers", { "webhook-id": vector.id }],
    ["malformed", { ...headersOf(), "webhook-timestamp": "hello" }],
    ["malformed", { ...headersOf(), "webhook-id": "has space" }],
    ["malformed", headersOf("v1,dawfeoifkpqwoekfpqoekf")],
    ["malformed", headersOf(vector.signature.slice(0, 8))],
    ["malformed", headersOf("v1a,AAAA")],
  ] as const)("fails %s", async (cause, headers) => {
    const verifier = webhookVerifier({
      secret: vector.secret,
      replay: memoryReplayStore(),
      now: at(0),
    });
    expect(await verifier.verify({ headers, body: vector.body })).toEqual({
      ok: false,
      cause,
    });
  });

  it("signs and verifies v1a with Ed25519 keys from a JWKS", async () => {
    const { privateJwk, publicJwk } = await ed25519Pair();
    const signer = webhookSigner({
      keys: [
        { alg: "v1", secret: vector.secret },
        { alg: "v1a", privateKey: privateJwk },
      ],
    });
    const now = Temporal.Now.instant();
    const headers = await signer.sign({ id: "msg_1", body: "{}", now });
    expect(headers["webhook-signature"]).toMatch(/^v1,\S+ v1a,\S+$/u);
    const v1aOnly = headers["webhook-signature"].split(" ")[1] ?? "";
    let fetched = 0;
    const verifier = webhookVerifier({
      jwks: "https://cloud.permdock.test/.well-known/jwks.json",
      replay: memoryReplayStore(),
      now: () => now,
      fetch: async () => {
        fetched += 1;
        return Response.json({ keys: [{ kty: "RSA" }, publicJwk] });
      },
    });
    expect(
      (
        await verifier.verify({
          headers: { ...headers, "webhook-signature": v1aOnly },
          body: "{}",
        })
      ).ok,
    ).toBe(true);
    expect(
      await verifier.verify({
        headers: {
          ...headers,
          "webhook-id": "msg_2",
          "webhook-signature": v1aOnly,
        },
        body: "{}",
      }),
    ).toEqual({ ok: false, cause: "invalid-signature" });
    expect(fetched).toBe(1);
  });

  it("verifies v1a against an inline key set and reports unavailable keys", async () => {
    const { privateJwk, publicJwk } = await ed25519Pair();
    const signer = webhookSigner({
      keys: [{ alg: "v1a", privateKey: privateJwk }],
    });
    const now = Temporal.Now.instant();
    const headers = await signer.sign({ id: "msg_1", body: "{}", now });
    const inline = webhookVerifier({
      jwks: { keys: [publicJwk] },
      replay: memoryReplayStore(),
      now: () => now,
    });
    expect((await inline.verify({ headers, body: "{}" })).ok).toBe(true);
    const offline = webhookVerifier({
      jwks: new URL("https://cloud.permdock.test/jwks"),
      replay: memoryReplayStore(),
      now: () => now,
      fetch: async () => new Response(null, { status: 503 }),
    });
    expect(await offline.verify({ headers, body: "{}" })).toEqual({
      ok: false,
      cause: "keys-unavailable",
    });
    const secretOnly = webhookVerifier({
      secret: vector.secret,
      replay: memoryReplayStore(),
      now: () => now,
    });
    expect(await secretOnly.verify({ headers, body: "{}" })).toEqual({
      ok: false,
      cause: "invalid-signature",
    });
  });

  it("skips a key that does not import and fails closed on a read body or a throwing fetch", async () => {
    const { privateJwk, publicJwk } = await ed25519Pair();
    const signer = webhookSigner({
      keys: [{ alg: "v1a", privateKey: privateJwk }],
    });
    const now = Temporal.Now.instant();
    const headers = await signer.sign({ id: "msg_1", body: "{}", now });
    const inline = webhookVerifier({
      jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "AA" }, publicJwk] },
      replay: memoryReplayStore(),
      now: () => now,
    });
    const read = new Request("https://app.example.com/webhooks", {
      method: "POST",
      headers,
      body: "{}",
    });
    await read.text();
    expect(await inline.verify(read)).toEqual({
      ok: false,
      cause: "malformed",
    });
    expect((await inline.verify({ headers, body: "{}" })).ok).toBe(true);
    const unreachable = webhookVerifier({
      jwks: "https://cloud.permdock.test/jwks",
      replay: memoryReplayStore(),
      now: () => now,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(await unreachable.verify({ headers, body: "{}" })).toEqual({
      ok: false,
      cause: "keys-unavailable",
    });
  });

  it("refuses an invalid configuration", () => {
    expect(() => webhookSigner({ keys: [] })).toThrow(TypeError);
    expect(() =>
      webhookVerifier({ secret: "whsec_", replay: memoryReplayStore() }),
    ).toThrow(TypeError);
    expect(() =>
      webhookVerifier({
        secret: `whsec_${btoa("short")}`,
        replay: memoryReplayStore(),
      }),
    ).toThrow(TypeError);
  });

  it("rejects an invalid key or id when signing", async () => {
    const signer = webhookSigner({
      keys: [{ alg: "v1", secret: vector.secret }],
    });
    await expect(signer.sign({ id: "", body: "{}" })).rejects.toThrow(
      TypeError,
    );
    const bad = webhookSigner({
      keys: [{ alg: "v1a", privateKey: { kty: "OKP", crv: "Ed25519" } }],
    });
    await expect(bad.sign({ id: "msg_1", body: "{}" })).rejects.toThrow(
      TypeError,
    );
  });
});
