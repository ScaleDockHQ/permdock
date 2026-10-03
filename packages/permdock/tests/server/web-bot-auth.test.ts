import { beforeAll, describe, expect, it } from "vitest";

import type {
  WebBotAuthJwk,
  WebBotAuthKeyLookup,
  WebBotAuthOptions,
} from "../../src/server/web-bot-auth.ts";

import {
  InvalidSignatureError,
  discoverViaSignatureAgent,
  invalidSignatureProblem,
  invalidSignatureResponse,
  verifyWebBotAuth,
} from "../../src/server/web-bot-auth.ts";
import { fakeFetch, json } from "../fakes/fetch.ts";

const NOW = 1_800_000_000;
const SIGNED_URL = "https://shop.example/api/items?page=2";

type Signer = {
  readonly jwk: WebBotAuthJwk;
  readonly sign: (data: Uint8Array) => Promise<Uint8Array>;
};

let ed: Signer;
let ec: Signer;

beforeAll(async () => {
  const edKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const ecKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  ed = {
    jwk: {
      ...(await crypto.subtle.exportKey("jwk", edKeys.publicKey)),
      kid: "ed-key",
    },
    sign: async (data) =>
      new Uint8Array(
        // SAFETY: the verifier hands sign a freshly encoded signature base backed by an ArrayBuffer.
        await crypto.subtle.sign(
          "Ed25519",
          edKeys.privateKey,
          data as Uint8Array<ArrayBuffer>,
        ),
      ),
  };
  ec = {
    jwk: {
      ...(await crypto.subtle.exportKey("jwk", ecKeys.publicKey)),
      kid: "ec-key",
    },
    sign: async (data) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          ecKeys.privateKey,
          // SAFETY: the verifier hands sign a freshly encoded signature base backed by an ArrayBuffer.
          data as Uint8Array<ArrayBuffer>,
        ),
      ),
  };
});

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/** Builds an RFC 9421 signature base independently of the code under test. */
function baseFor(
  request: Request,
  components: readonly string[],
  params: string,
): string {
  const url = new URL(request.url);
  const derived: Record<string, string> = {
    "@method": request.method,
    "@authority": url.host,
    "@path": url.pathname,
    "@query": url.search,
    "@target-uri": url.href,
    "@scheme": url.protocol.replace(":", ""),
    "@request-target": `${url.pathname}${url.search}`,
  };
  const lines = components.map(
    (name) => `"${name}": ${derived[name] ?? request.headers.get(name) ?? ""}`,
  );
  const inner = `(${components.map((name) => `"${name}"`).join(" ")})${params}`;
  lines.push(`"@signature-params": ${inner}`);
  return lines.join("\n");
}

async function signed(
  signer: Signer,
  input: {
    readonly components?: readonly string[];
    readonly params?: string;
    readonly headers?: Record<string, string>;
    readonly label?: string;
  } = {},
): Promise<Request> {
  const components = input.components ?? ["@method", "@authority", "@path"];
  const params =
    input.params ??
    `;created=${NOW};keyid="${String(signer.jwk.kid)}";tag="web-bot-auth"`;
  const label = input.label ?? "sig1";
  const unsigned = new Request(
    SIGNED_URL,
    input.headers === undefined ? {} : { headers: input.headers },
  );
  const signature = await signer.sign(
    new TextEncoder().encode(baseFor(unsigned, components, params)),
  );
  const inner = `(${components.map((name) => `"${name}"`).join(" ")})${params}`;
  return new Request(SIGNED_URL, {
    headers: {
      ...input.headers,
      "Signature-Input": `${label}=${inner}`,
      Signature: `${label}=:${base64(signature)}:`,
    },
  });
}

function options(
  keys: WebBotAuthOptions["keys"],
  extra: Partial<WebBotAuthOptions> = {},
): WebBotAuthOptions {
  return { keys, now: () => NOW, ...extra };
}

async function detailOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof InvalidSignatureError)) {
    throw new TypeError(`expected InvalidSignatureError, got ${String(error)}`);
  }
  expect(error.response.status).toBe(403);
  // SAFETY: invalidSignatureProblem always writes a Problem Details object.
  const body = (await error.response.json()) as { readonly detail: string };
  return body.detail;
}

describe("verifyWebBotAuth", () => {
  it("verifies Ed25519 and ECDSA P-256 signatures over every derived component", async () => {
    const components = [
      "@method",
      "@authority",
      "@path",
      "@query",
      "@target-uri",
      "@scheme",
      "@request-target",
      "user-agent",
    ];
    const headers = { "user-agent": "Bot/1.0" };
    for (const signer of [ed, ec]) {
      const request = await signed(signer, { components, headers });
      expect(
        await verifyWebBotAuth(
          request,
          options(() => signer.jwk),
        ),
      ).toEqual({
        id: signer.jwk.kid,
        kind: "web-bot-auth",
      });
    }
  });

  it("honours an explicit alg and a key lookup object", async () => {
    const request = await signed(ec, {
      params: `;created=${NOW};keyid="ec-key";alg="ecdsa-p256-sha256"`,
    });
    expect(
      await verifyWebBotAuth(request, options({ lookup: () => ec.jwk })),
    ).toMatchObject({ id: "ec-key" });
  });

  it("skips verification when off or absent, and requires a signature when asked", async () => {
    const bare = new Request(SIGNED_URL);
    expect(await verifyWebBotAuth(bare, undefined)).toBeUndefined();
    expect(
      await verifyWebBotAuth(
        await signed(ed),
        options(() => undefined, { verify: false }),
      ),
    ).toBeUndefined();
    expect(
      await verifyWebBotAuth(
        bare,
        options(() => ed.jwk),
      ),
    ).toBeUndefined();
    expect(
      await detailOf(
        verifyWebBotAuth(
          bare,
          options(() => ed.jwk, { required: true }),
        ),
      ),
    ).toBe("Signature-Input is required");
  });

  it.each<[string, Record<string, string>, string]>([
    [
      "an unparsable Signature-Input",
      { "Signature-Input": "garbage", Signature: "sig1=:AA==:" },
      "Signature-Input could not be parsed",
    ],
    [
      "a Signature-Input without a list",
      { "Signature-Input": 'sig1="x"', Signature: "sig1=:AA==:" },
      "Signature-Input could not be parsed",
    ],
    [
      "an unclosed component list",
      { "Signature-Input": 'sig1=("@method"', Signature: "sig1=:AA==:" },
      "Signature-Input could not be parsed",
    ],
    [
      "an unquoted component",
      { "Signature-Input": "sig1=(@method)", Signature: "sig1=:AA==:" },
      "Signature-Input could not be parsed",
    ],
    [
      "a half-quoted component",
      { "Signature-Input": 'sig1=("@method)', Signature: "sig1=:AA==:" },
      "Signature-Input could not be parsed",
    ],
    [
      "no Signature header",
      { "Signature-Input": `sig1=("@method");created=${NOW}` },
      "Signature-Input could not be parsed",
    ],
    [
      "a Signature for another label",
      {
        "Signature-Input": `sig1=("@method");created=${NOW}`,
        Signature: "sig2=:AA==:",
      },
      "Signature could not be parsed",
    ],
    [
      "a Signature that is not a byte sequence",
      {
        "Signature-Input": `sig1=("@method");created=${NOW}`,
        Signature: 'sig1="AA=="',
      },
      "Signature could not be parsed",
    ],
    [
      "a Signature with bad base64",
      {
        "Signature-Input": `sig1=("@method");created=${NOW}`,
        Signature: "sig1=:!!!:",
      },
      "Signature could not be parsed",
    ],
    [
      "a missing created",
      {
        "Signature-Input": 'sig1=("@method");keyid="k"',
        Signature: "sig1=:AA==:",
      },
      "Signature-Input created is required",
    ],
    [
      "a non-numeric created",
      {
        "Signature-Input": 'sig1=("@method");created=soon;keyid="k"',
        Signature: "sig1=:AA==:",
      },
      "Signature-Input created is required",
    ],
    [
      "a future created",
      {
        "Signature-Input": `sig1=("@method");created=${NOW + 61};keyid="k"`,
        Signature: "sig1=:AA==:",
      },
      "Signature-Input created is in the future",
    ],
    [
      "an old created",
      {
        "Signature-Input": `sig1=("@method");created=${NOW - 301};keyid="k"`,
        Signature: "sig1=:AA==:",
      },
      "Signature-Input created is too old",
    ],
    [
      "a past expires",
      {
        "Signature-Input": `sig1=("@method");created=${NOW};expires=${NOW - 1};keyid="k"`,
        Signature: "sig1=:AA==:",
      },
      "Signature-Input expires is in the past",
    ],
    [
      "no keyid",
      {
        "Signature-Input": `sig1=("@method");created=${NOW}`,
        Signature: "sig1=:AA==:",
      },
      "Signature-Input keyid is required",
    ],
    [
      "an unterminated quoted keyid",
      {
        "Signature-Input": `sig1=("@method");created=${NOW};keyid="k`,
        Signature: "sig1=:AA==:",
      },
      "Signature-Input keyid is required",
    ],
  ])("rejects %s", async (_label, headers, detail) => {
    const request = new Request(SIGNED_URL, { headers });
    expect(
      await detailOf(
        verifyWebBotAuth(
          request,
          options(() => ed.jwk),
        ),
      ),
    ).toBe(detail);
  });

  it("rejects a failing or empty key lookup", async () => {
    const request = await signed(ed);
    expect(
      await detailOf(
        verifyWebBotAuth(
          request,
          options(() => {
            throw new Error("directory down");
          }),
        ),
      ),
    ).toBe("Web Bot Auth key lookup failed");
    expect(
      await detailOf(
        verifyWebBotAuth(
          request,
          options(() => undefined),
        ),
      ),
    ).toBe("Web Bot Auth key was not found");
  });

  it("rejects an unknown derived component or a missing header", async () => {
    const edKey: WebBotAuthKeyLookup = () => ed.jwk;
    for (const component of ["@status", "x-missing"]) {
      const request = new Request(SIGNED_URL, {
        headers: {
          "Signature-Input": `sig1=("${component}");created=${NOW};keyid="ed-key"`,
          Signature: "sig1=:AA==:",
        },
      });
      expect(await detailOf(verifyWebBotAuth(request, options(edKey)))).toBe(
        "signed components could not be covered",
      );
    }
  });

  it("rejects a key whose algorithm it cannot infer", async () => {
    const request = await signed(ed);
    for (const jwk of [
      { kty: "RSA", kid: "ed-key" },
      { kty: "OKP", crv: "X25519", kid: "ed-key" },
      { kty: "EC", crv: "P-384", kid: "ed-key" },
    ]) {
      expect(
        await detailOf(
          verifyWebBotAuth(
            request,
            options(() => jwk),
          ),
        ),
      ).toBe("signature algorithm is not supported");
    }
  });

  it.each<[string, () => Promise<Request>, () => WebBotAuthJwk]>([
    [
      "a tampered request",
      async () => {
        const good = await signed(ed);
        return new Request("https://other.example/api/items", {
          headers: good.headers,
        });
      },
      () => ed.jwk,
    ],
    ["the wrong key", () => signed(ed), () => ({ ...ec.jwk, kid: "ed-key" })],
    [
      "an unsupported explicit alg",
      () =>
        signed(ed, {
          params: `;created=${NOW};keyid="ed-key";alg="rsa-pss-sha512"`,
        }),
      () => ed.jwk,
    ],
    [
      "an ECDSA key named as ed25519",
      () =>
        signed(ec, { params: `;created=${NOW};keyid="ec-key";alg="ed25519"` }),
      () => ec.jwk,
    ],
    [
      "an Ed25519 key named as ECDSA",
      () =>
        signed(ed, {
          params: `;created=${NOW};keyid="ed-key";alg="ecdsa-p256-sha256"`,
        }),
      () => ed.jwk,
    ],
  ])("rejects %s", async (_label, request, key) => {
    expect(
      await detailOf(verifyWebBotAuth(await request(), options(key))),
    ).toBe("HTTP Message Signature did not verify");
  });

  it("accepts a signature whose expiry is still ahead and ignores junk parameters", async () => {
    const request = await signed(ed, {
      params: `;created=${NOW};expires=${NOW + 60};keyid="ed-key";;nonce;tag="x"`,
    });
    expect(
      await verifyWebBotAuth(
        request,
        options(() => ed.jwk),
      ),
    ).toMatchObject({ id: "ed-key" });
  });

  it("passes the Signature-Agent for the signature label to the lookup", async () => {
    const agents: (string | undefined)[] = [];
    const lookup: WebBotAuthOptions["keys"] = ({ agent }) => {
      agents.push(agent);
      return ed.jwk;
    };
    for (const header of [
      '"https://bots.example"',
      'other="https://x.example", sig1="https://bots.example/dir"',
      'first="https://first.example"',
      "sig1=https://plain.example",
      "garbage",
      'sig1="broken',
    ]) {
      const request = await signed(ed, {
        headers: { "Signature-Agent": header },
      });
      await verifyWebBotAuth(request, options(lookup));
    }
    expect(agents).toEqual([
      "https://bots.example",
      "https://bots.example/dir",
      "https://first.example",
      "https://plain.example",
      undefined,
      undefined,
    ]);
  });
});

describe("discoverViaSignatureAgent", () => {
  const directory = {
    keys: [{ kty: "OKP", crv: "Ed25519", kid: "k1", x: "abc" }, "junk"],
  };

  it("fetches the well-known directory of an allowed agent once and finds the key", async () => {
    const transport = fakeFetch(() => json(directory));
    const { lookup } = discoverViaSignatureAgent({
      allow: ["bots.example"],
      fetch: transport.fetch,
    });
    const request = new Request(SIGNED_URL);
    expect(
      await lookup({ request, keyid: "k1", agent: "https://bots.example" }),
    ).toMatchObject({ kid: "k1" });
    expect(
      await lookup({ request, keyid: "k2", agent: "https://bots.example/" }),
    ).toBeUndefined();
    expect(transport.calls.map((call) => call.url)).toEqual([
      "https://bots.example/.well-known/http-message-signatures-directory",
    ]);
    await lookup({
      request,
      keyid: "k1",
      agent: "https://bots.example/keys.json",
    });
    expect(transport.calls.at(-1)?.url).toBe("https://bots.example/keys.json");
  });

  it.each<[string, string | undefined]>([
    ["no agent", undefined],
    ["an invalid URL", "not a url"],
    ["plain http", "http://bots.example"],
    ["a host outside the allow list", "https://evil.example"],
  ])("finds no key for %s and never fetches", async (_label, agent) => {
    const transport = fakeFetch(() => json(directory));
    const { lookup } = discoverViaSignatureAgent({
      allow: ["bots.example"],
      fetch: transport.fetch,
    });
    expect(
      await lookup({ request: new Request(SIGNED_URL), keyid: "k1", agent }),
    ).toBeUndefined();
    expect(transport.calls).toEqual([]);
  });

  it.each<[string, () => Response]>([
    ["a non-object body", () => json(["k1"])],
    ["a body without a key list", () => json({ keys: "k1" })],
    ["a null body", () => json(null)],
  ])("finds no key in %s", async (_label, reply) => {
    const { lookup } = discoverViaSignatureAgent({
      allow: ["bots.example"],
      fetch: fakeFetch(reply).fetch,
    });
    expect(
      await lookup({
        request: new Request(SIGNED_URL),
        keyid: "k1",
        agent: "https://bots.example",
      }),
    ).toBeUndefined();
  });

  it("retries the directory after a failed fetch", async () => {
    let fail = true;
    const transport = fakeFetch(() => (fail ? json({}, 500) : json(directory)));
    const { lookup } = discoverViaSignatureAgent({
      allow: ["bots.example"],
      fetch: transport.fetch,
    });
    const input = {
      request: new Request(SIGNED_URL),
      keyid: "k1",
      agent: "https://bots.example",
    };
    expect(await lookup(input)).toBeUndefined();
    fail = false;
    expect(await lookup(input)).toMatchObject({ kid: "k1" });
    expect(transport.calls).toHaveLength(2);
  });
});

describe("invalid signature helpers", () => {
  it("answers a 403 Problem Details only for InvalidSignatureError", async () => {
    const response = invalidSignatureProblem("bad");
    const error = new InvalidSignatureError(response);
    expect(invalidSignatureResponse(error)).toBe(response);
    expect(invalidSignatureResponse(new Error("other"))).toBeUndefined();
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 403,
      body: { title: "Invalid signature", detail: "bad", status: 403 },
    });
  });
});
