import { beforeAll, describe, expect, it } from "vitest";

import type { WebBotAuthJwk } from "../../src/server/index.ts";

import {
  createPermDock,
  discoverViaSignatureAgent,
  InvalidSignatureError,
} from "../../src/server/index.ts";
import {
  verifyMessageSignature,
  verifyWebBotAuth,
} from "../../src/server/web-bot-auth.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";
import { memberUser, policy } from "../fixtures/quick-start.ts";
import { standardsFixture } from "./fixtures.ts";

const vector = standardsFixture("rfc9421-ed25519.json");
const created = 1_618_884_473;
const { d: _private, ...publicKey } = vector.key;
const at = (): number => created + 10;

function vectorRequest(
  overrides: Readonly<Record<string, string>> = {},
): Request {
  return new Request(vector.request.url, {
    method: vector.request.method,
    headers: {
      ...vector.request.headers,
      "Signature-Input": vector.signatureInput,
      Signature: vector.signature,
      ...overrides,
    },
    body: vector.request.body,
  });
}

let agentKey: WebBotAuthJwk;
let agentSign: (data: Uint8Array) => Promise<Uint8Array>;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  agentKey = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "agent-key",
  };
  agentSign = async (data) =>
    new Uint8Array(
      // SAFETY: TextEncoder output is backed by a plain ArrayBuffer.
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        data as Uint8Array<ArrayBuffer>,
      ),
    );
});

/**
 * A request signed under the Web Bot Auth profile: tag `web-bot-auth`,
 * `@authority` covered, and `signature-agent` covered when the header is sent.
 */
async function agentRequest(
  headers: Readonly<Record<string, string>> = {},
  components: readonly string[] = [
    "@method",
    "@authority",
    "@path",
    ...("Signature-Agent" in headers ? ["signature-agent"] : []),
  ],
): Promise<Request> {
  const url = new URL("https://example.com/foo");
  const params = `(${components.map((name) => `"${name}"`).join(" ")});created=${String(created)};keyid="agent-key";tag="web-bot-auth"`;
  const value = (name: string): string =>
    ({ "@method": "GET", "@authority": url.host, "@path": url.pathname })[
      name
    ] ??
    headers[name === "signature-agent" ? "Signature-Agent" : name] ??
    "";
  const base = [
    ...components.map((name) => `"${name}": ${value(name)}`),
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = await agentSign(new TextEncoder().encode(base));
  return new Request(url, {
    headers: {
      ...headers,
      "Signature-Input": `sig1=${params}`,
      Signature: `sig1=:${btoa(String.fromCodePoint(...signature))}:`,
    },
  });
}

async function rejection(promise: Promise<unknown>): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(InvalidSignatureError);
  if (!(error instanceof InvalidSignatureError)) {
    throw new TypeError("expected InvalidSignatureError");
  }
  return {
    status: error.response.status,
    contentType: error.response.headers.get("content-type"),
    // SAFETY: invalidSignatureProblem always writes a Problem Details object.
    body: (await error.response.json()) as Readonly<Record<string, unknown>>,
  };
}

describe("RFC 9421 HTTP Message Signatures (February 2024)", () => {
  it("appendix B.2.6: the ed25519 test-request signature verifies with test-key-ed25519", async () => {
    const actor = await verifyMessageSignature(vectorRequest(), {
      keys: () => publicKey,
      now: at,
    });
    expect(actor).toEqual({ id: "test-key-ed25519", kind: "web-bot-auth" });
  });

  it("section 3.2: a changed covered component fails verification", async () => {
    const failure = await rejection(
      verifyMessageSignature(
        vectorRequest({ Date: "Tue, 20 Apr 2021 02:07:56 GMT" }),
        { keys: () => publicKey, now: at },
      ),
    );
    expect(failure.status).toBe(403);
    expect(failure.body["detail"]).toBe(
      "HTTP Message Signature did not verify",
    );
  });

  it("section 3.2: a changed signature value fails verification", async () => {
    const signature = vector.signature.replace(":wqc", ":wqd");
    const failure = await rejection(
      verifyMessageSignature(vectorRequest({ Signature: signature }), {
        keys: () => publicKey,
        now: at,
      }),
    );
    expect(failure.body["detail"]).toBe(
      "HTTP Message Signature did not verify",
    );
  });

  it("section 2.3: changed signature parameters change the signature base", async () => {
    const input = vector.signatureInput.replace(
      "created=1618884473",
      "created=1618884474",
    );
    const failure = await rejection(
      verifyMessageSignature(vectorRequest({ "Signature-Input": input }), {
        keys: () => publicKey,
        now: at,
      }),
    );
    expect(failure.body["detail"]).toBe(
      "HTTP Message Signature did not verify",
    );
  });

  it("section 3.2: a covered component missing from the message fails", async () => {
    const request = vectorRequest();
    const stripped = new Request(request.url, {
      method: request.method,
      headers: [...request.headers].filter(([name]) => name !== "date"),
      body: vector.request.body,
    });
    const failure = await rejection(
      verifyMessageSignature(stripped, { keys: () => publicKey, now: at }),
    );
    expect(failure.body["detail"]).toBe(
      "signed components could not be covered",
    );
  });

  it("section 3.3.4: an ecdsa-p256-sha256 signature verifies from a P-256 JWK", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const params = `("@method" "@authority" "@path");created=${String(created)};keyid="p256"`;
    const base = [
      '"@method": GET',
      '"@authority": example.com',
      '"@path": /foo',
      `"@signature-params": ${params}`,
    ].join("\n");
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(base),
      ),
    );
    const request = new Request("https://example.com/foo", {
      headers: {
        "Signature-Input": `sig1=${params}`,
        Signature: `sig1=:${btoa(String.fromCodePoint(...signature))}:`,
      },
    });
    const key: WebBotAuthJwk = {
      kty: "EC",
      crv: "P-256",
      x: String(jwk.x),
      y: String(jwk.y),
    };
    await expect(
      verifyMessageSignature(request, { keys: () => key, now: at }),
    ).resolves.toEqual({ id: "p256", kind: "web-bot-auth" });
  });

  it("section 7.2.2: created is required and bounded by maxAge and future skew", async () => {
    const noCreated = vector.signatureInput.replace(";created=1618884473", "");
    const missing = await rejection(
      verifyMessageSignature(vectorRequest({ "Signature-Input": noCreated }), {
        keys: () => publicKey,
        now: at,
      }),
    );
    expect(missing.body["detail"]).toBe("Signature-Input created is required");
    const stale = await rejection(
      verifyMessageSignature(vectorRequest(), {
        keys: () => publicKey,
        now: () => created + 301,
      }),
    );
    expect(stale.body["detail"]).toBe("Signature-Input created is too old");
    const future = await rejection(
      verifyMessageSignature(vectorRequest(), {
        keys: () => publicKey,
        now: () => created - 61,
      }),
    );
    expect(future.body["detail"]).toBe(
      "Signature-Input created is in the future",
    );
    await expect(
      verifyMessageSignature(vectorRequest(), {
        keys: () => publicKey,
        now: () => created + 3600,
        maxAge: 3600,
      }),
    ).resolves.toBeDefined();
  });

  it("section 2.3: an expires in the past rejects", async () => {
    const input = `${vector.signatureInput};expires=${String(created + 5)}`;
    const failure = await rejection(
      verifyMessageSignature(vectorRequest({ "Signature-Input": input }), {
        keys: () => publicKey,
        now: at,
      }),
    );
    expect(failure.body["detail"]).toBe(
      "Signature-Input expires is in the past",
    );
  });
});

describe("draft-meunier-webbotauth-httpsig-protocol-02", () => {
  it("rejects with Problem Details of type invalid-signature, never as anonymous", async () => {
    const failure = await rejection(
      verifyWebBotAuth(vectorRequest({ Signature: "sig-b26=:AAAA:" }), {
        keys: () => publicKey,
        now: at,
      }),
    );
    expect(failure.status).toBe(403);
    expect(failure.contentType).toBe("application/problem+json");
    expect(failure.body).toMatchObject({
      type: "https://permdock.com/problems/invalid-signature",
      title: "Invalid signature",
      status: 403,
    });
  });

  it("an unsigned request has no actor unless a signature is required", async () => {
    const unsigned = new Request("https://example.com/foo");
    await expect(
      verifyWebBotAuth(unsigned, { keys: () => publicKey }),
    ).resolves.toBeUndefined();
    const failure = await rejection(
      verifyWebBotAuth(unsigned, { keys: () => publicKey, required: true }),
    );
    expect(failure.body["detail"]).toBe("Signature-Input is required");
  });

  it("a request signed under the profile verifies", async () => {
    await expect(
      verifyWebBotAuth(await agentRequest(), { keys: () => agentKey, now: at }),
    ).resolves.toEqual({ id: "agent-key", kind: "web-bot-auth" });
  });

  it("the tag is web-bot-auth, @authority is covered, and so is a sent Signature-Agent", async () => {
    const untagged = await rejection(
      verifyWebBotAuth(vectorRequest(), { keys: () => publicKey, now: at }),
    );
    expect(untagged.body["detail"]).toBe(
      'Signature-Input tag must be "web-bot-auth"',
    );
    const noAuthority = await rejection(
      verifyWebBotAuth(await agentRequest({}, ["@method", "@path"]), {
        keys: () => agentKey,
        now: at,
      }),
    );
    expect(noAuthority.body["detail"]).toBe(
      "Signature-Input must cover @authority",
    );
    const uncovered = await rejection(
      verifyWebBotAuth(
        await agentRequest(
          { "Signature-Agent": '"https://agents.example.com"' },
          ["@method", "@authority", "@path"],
        ),
        { keys: () => agentKey, now: at },
      ),
    );
    expect(uncovered.body["detail"]).toBe(
      "Signature-Input must cover signature-agent",
    );
  });

  it("a key the lookup does not know rejects, and a throwing lookup rejects", async () => {
    const unknown = await rejection(
      verifyWebBotAuth(await agentRequest(), {
        keys: () => undefined,
        now: at,
      }),
    );
    expect(unknown.body["detail"]).toBe("Web Bot Auth key was not found");
    const thrown = await rejection(
      verifyWebBotAuth(await agentRequest(), {
        keys: () => {
          throw new Error("directory down");
        },
        now: at,
      }),
    );
    expect(thrown.body["detail"]).toBe("Web Bot Auth key lookup failed");
  });

  it("the HTTP kernel fills actor from a verified signature", async () => {
    const { getPermDock: permdockFor } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: (request) =>
        verifyWebBotAuth(request, {
          verify: true,
          keys: () => agentKey,
          now: at,
        }),
    });
    const permdock = await permdockFor(await agentRequest());
    expect(permdock.subject.actor).toEqual({
      id: "agent-key",
      kind: "web-bot-auth",
    });
  });
});

describe("draft-meunier-http-message-signatures-directory-05", () => {
  const directory = (): { readonly keys: readonly WebBotAuthJwk[] } => ({
    keys: [agentKey],
  });

  it("Signature-Agent names the directory at the well-known path", async () => {
    const remote = fakeFetch(() => json(directory()));
    const keys = discoverViaSignatureAgent({
      allow: ["agents.example.com"],
      fetch: remote.fetch,
    });
    const actor = await verifyWebBotAuth(
      await agentRequest({ "Signature-Agent": '"https://agents.example.com"' }),
      { keys, now: at },
    );
    expect(actor?.id).toBe("agent-key");
    expect(remote.calls.map((call) => call.url)).toEqual([
      "https://agents.example.com/.well-known/http-message-signatures-directory",
    ]);
    expect(remote.calls[0]?.headers.get("accept")).toContain(
      "application/http-message-signatures-directory+json",
    );
  });

  it("Signature-Agent as a dictionary member keyed by the signature label", async () => {
    const remote = fakeFetch(() => json(directory()));
    const keys = discoverViaSignatureAgent({
      allow: ["agents.example.com"],
      fetch: remote.fetch,
    });
    await expect(
      verifyWebBotAuth(
        await agentRequest({
          "Signature-Agent": 'sig1="https://agents.example.com/keys.json"',
        }),
        { keys, now: at },
      ),
    ).resolves.toBeDefined();
    expect(remote.calls[0]?.url).toBe("https://agents.example.com/keys.json");
  });

  it("the directory is fetched once and reused", async () => {
    const remote = fakeFetch(() => json(directory()));
    const keys = discoverViaSignatureAgent({
      allow: ["agents.example.com"],
      fetch: remote.fetch,
    });
    const agent = { "Signature-Agent": '"https://agents.example.com"' };
    await verifyWebBotAuth(await agentRequest(agent), { keys, now: at });
    await verifyWebBotAuth(await agentRequest(agent), { keys, now: at });
    expect(remote.calls).toHaveLength(1);
  });

  it("a host off the allow-list, plain http or no Signature-Agent finds no key", async () => {
    const remote = fakeFetch(() => json(directory()));
    const keys = discoverViaSignatureAgent({
      allow: ["agents.example.com"],
      fetch: remote.fetch,
    });
    for (const agent of [
      '"https://evil.example.com"',
      '"http://agents.example.com"',
      '"not a url"',
    ]) {
      const failure = await rejection(
        verifyWebBotAuth(await agentRequest({ "Signature-Agent": agent }), {
          keys,
          now: at,
        }),
      );
      expect(failure.body["detail"]).toBe("Web Bot Auth key was not found");
    }
    await rejection(verifyWebBotAuth(await agentRequest(), { keys, now: at }));
    expect(remote.calls).toHaveLength(0);
  });

  it("a failed directory fetch finds no key and is retried next time", async () => {
    let up = false;
    const remote = fakeFetch(() =>
      up ? json(directory()) : new Response("down", { status: 503 }),
    );
    const keys = discoverViaSignatureAgent({
      allow: ["agents.example.com"],
      fetch: remote.fetch,
    });
    const agent = { "Signature-Agent": '"https://agents.example.com"' };
    await rejection(
      verifyWebBotAuth(await agentRequest(agent), { keys, now: at }),
    );
    up = true;
    await expect(
      verifyWebBotAuth(await agentRequest(agent), { keys, now: at }),
    ).resolves.toBeDefined();
    expect(remote.calls).toHaveLength(2);
  });

  it("a directory body without a keys array yields no key", async () => {
    for (const body of [[], { keys: "nope" }, null]) {
      const remote = fakeFetch(() => json(body));
      const keys = discoverViaSignatureAgent({
        allow: ["agents.example.com"],
        fetch: remote.fetch,
      });
      await rejection(
        verifyWebBotAuth(
          await agentRequest({
            "Signature-Agent": '"https://agents.example.com"',
          }),
          { keys, now: at },
        ),
      );
    }
  });
});
