import { describe, expect, it } from "vitest";

import { CLOUD_BASE_URL } from "../../src/cloud/base-url.ts";
import { bearerChallenge } from "../../src/cloud/challenge.ts";
import { isCloudAuthError } from "../../src/cloud/oauth-error.ts";
import { cloudOAuth } from "../../src/cloud/oauth.ts";
import { referencePlatform } from "./fixtures/reference-platform.ts";

const BASE = "https://cloud.test";
const REDIRECT = "https://app.test/callback";

function platform() {
  const reference = referencePlatform({
    base: BASE,
    environment: "prj_ref",
    latest: () => undefined,
    mutation: undefined,
  });
  const fetchFn: typeof fetch = (input, init) =>
    reference.handle(new Request(input, init));
  return { reference, fetchFn };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/**
 * Runs the browser leg: the platform's `/oauth/authorize` redirect back to the
 * app.
 */
async function authorize(fetchFn: typeof fetch, url: string): Promise<string> {
  const response = await fetchFn(url, { redirect: "manual" });
  return response.headers.get("location") ?? "";
}

describe("cloudOAuth", () => {
  it("defaults to CLOUD_BASE_URL", () => {
    expect(cloudOAuth({ clientId: "app", redirectUri: REDIRECT }).issuer).toBe(
      CLOUD_BASE_URL,
    );
  });

  it("signs in with PKCE S256, refreshes and lists the projects", async () => {
    const { fetchFn } = platform();
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: fetchFn,
    });
    const pending = await client.authorizeUrl();
    const url = new URL(pending.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "app",
      redirect_uri: REDIRECT,
      scope: "projects:read policy:read",
      state: pending.state,
      code_challenge_method: "S256",
    });
    expect(pending.codeVerifier).toMatch(/^[\w-]{43}$/u);

    const credential = await client.exchangeCode(
      await authorize(fetchFn, pending.url),
      pending,
    );
    expect(credential).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      scope: "projects:read policy:read",
      expires_at: expect.any(Number),
    });

    const page = await client.listProjects(credential.access_token);
    expect(page.items.map((project) => project.id)).toEqual([
      "prj_ref",
      "empty",
    ]);
    expect(Object.isFrozen(page)).toBe(true);

    const refreshed = await client.refresh(credential.refresh_token ?? "");
    expect(refreshed.access_token).not.toBe(credential.access_token);
    const reused = await rejection(
      client.refresh(credential.refresh_token ?? ""),
    );
    expect(isCloudAuthError(reused)).toBe(true);
    expect(reused).toMatchObject({
      code: "token-refused",
      error: "invalid_grant",
      status: 400,
    });
  });

  it("refuses a callback with another state, another issuer or an error", async () => {
    const { fetchFn } = platform();
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: fetchFn,
    });
    const pending = await client.authorizeUrl();
    const callback = new URL(await authorize(fetchFn, pending.url));

    const forged = new URL(callback);
    forged.searchParams.set("state", "other");
    expect(await rejection(client.exchangeCode(forged, pending))).toMatchObject(
      { code: "state-mismatch" },
    );

    const mixedUp = new URL(callback);
    mixedUp.searchParams.set("iss", "https://evil.test");
    expect(
      await rejection(client.exchangeCode(mixedUp, pending)),
    ).toMatchObject({ code: "issuer-mismatch" });

    const denied = new URL(REDIRECT);
    denied.searchParams.set("state", pending.state);
    denied.searchParams.set("error", "access_denied");
    expect(await rejection(client.exchangeCode(denied, pending))).toMatchObject(
      { code: "authorization-denied", error: "access_denied" },
    );

    const replayedVerifier = await rejection(
      client.exchangeCode(callback, { ...pending, codeVerifier: "wrong" }),
    );
    expect(replayedVerifier).toMatchObject({
      code: "token-refused",
      error: "invalid_grant",
    });
  });

  it("tells a dead token from a missing scope by the RFC 6750 challenge", async () => {
    const { fetchFn } = platform();
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: fetchFn,
    });
    expect(await rejection(client.listProjects("at_unknown"))).toMatchObject({
      code: "invalid-token",
      status: 401,
      error: "invalid_token",
    });

    const pending = await client.authorizeUrl({ scopes: ["policy:read"] });
    const narrow = await client.exchangeCode(
      await authorize(fetchFn, pending.url),
      pending,
    );
    expect(
      await rejection(client.listProjects(narrow.access_token)),
    ).toMatchObject({
      code: "insufficient-scope",
      status: 403,
      error: "insufficient_scope",
      scope: "projects:read",
    });
  });

  it("refuses metadata for another issuer and endpoints over plain http", async () => {
    const metadata =
      (body: unknown): typeof fetch =>
      () =>
        Promise.resolve(Response.json(body));
    const wrongIssuer = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: metadata({
        issuer: "https://evil.test",
        authorization_endpoint: `${BASE}/oauth/authorize`,
        token_endpoint: `${BASE}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
      }),
    });
    expect(await rejection(wrongIssuer.authorizeUrl())).toMatchObject({
      code: "discovery-failed",
    });
    const plain = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: metadata({
        issuer: BASE,
        authorization_endpoint: "http://cloud.test/oauth/authorize",
        token_endpoint: `${BASE}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
      }),
    });
    expect(await rejection(plain.authorizeUrl())).toMatchObject({
      code: "discovery-failed",
    });
    const unparsable = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: metadata({
        issuer: BASE,
        authorization_endpoint: `${BASE}/oauth/authorize`,
        token_endpoint: "not a url",
        code_challenge_methods_supported: ["S256"],
      }),
    });
    expect(await rejection(unparsable.refresh("rt"))).toMatchObject({
      code: "discovery-failed",
    });
  });

  it("authenticates a confidential client with client_secret_basic", async () => {
    const { fetchFn } = platform();
    const sent: Request[] = [];
    const client = cloudOAuth({
      clientId: "app id",
      clientSecret: "s3cr:t",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: (input, init) => {
        const request = new Request(input, init);
        sent.push(request.clone());
        return fetchFn(request);
      },
    });
    await rejection(client.refresh("rt_unknown"));
    const token = sent.find((request) => request.url.endsWith("/oauth/token"));
    expect(token?.headers.get("authorization")).toBe(
      `Basic ${btoa("app+id:s3cr%3At")}`,
    );
    expect(new URLSearchParams(await token?.text()).has("client_id")).toBe(
      false,
    );
  });

  it("refuses a project list that does not match the contract", async () => {
    const { fetchFn } = platform();
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: (input, init) => {
        const request = new Request(input, init);
        return new URL(request.url).pathname === "/v1/projects"
          ? Promise.resolve(Response.json({ items: [{ id: "prj" }] }))
          : fetchFn(request);
      },
    });
    expect(await rejection(client.listProjects("at"))).toMatchObject({
      code: "unexpected-response",
    });
  });

  it("maps the read API's refusals and sends the cursor", async () => {
    const answers: Response[] = [];
    const urls: string[] = [];
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(answers.shift() ?? new Response(null));
      },
    });
    const refused = async (response: Response): Promise<unknown> => {
      answers.push(response);
      return rejection(client.listProjects("at"));
    };
    expect(await refused(new Response(null, { status: 403 }))).toMatchObject({
      code: "forbidden",
      status: 403,
    });
    expect(
      await refused(
        new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    ).toMatchObject({ code: "rate-limited", status: 429 });
    expect(await refused(new Response(null, { status: 503 }))).toMatchObject({
      code: "unexpected-response",
      status: 503,
    });
    expect(await refused(new Response("not json"))).toMatchObject({
      code: "unexpected-response",
    });
    const project = {
      id: "prj",
      name: "Project",
      environment: "prj",
      catalog: { version: 2, fingerprint: "sha-256:x" },
    };
    expect(
      await refused(Response.json({ items: [{ ...project, catalog: {} }] })),
    ).toMatchObject({ code: "unexpected-response" });
    answers.push(Response.json({ items: [project], next: "c2" }));
    expect(await client.listProjects("at", { cursor: "c1" })).toEqual({
      items: [project],
      next: "c2",
    });
    expect(urls.at(-1)).toBe(`${BASE}/v1/projects?cursor=c1`);
  });

  it("refuses a token answer that is not JSON or a callback that is not a URL", async () => {
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: (input) =>
        Promise.resolve(
          String(input).endsWith("/oauth-authorization-server")
            ? Response.json({
                issuer: BASE,
                authorization_endpoint: `${BASE}/oauth/authorize`,
                token_endpoint: `${BASE}/oauth/token`,
                code_challenge_methods_supported: ["S256"],
              })
            : new Response("<html>", { status: 502 }),
        ),
    });
    expect(await rejection(client.refresh("rt"))).toMatchObject({
      code: "unexpected-response",
      status: 502,
    });
    expect(
      await rejection(
        client.exchangeCode("not a url", { state: "s", codeVerifier: "v" }),
      ),
    ).toMatchObject({ code: "authorization-denied" });
    expect(isCloudAuthError(new Error("plain"))).toBe(false);
    expect(isCloudAuthError("CloudAuthError")).toBe(false);
  });

  it("answers unreachable when fetch throws", async () => {
    const client = cloudOAuth({
      clientId: "app",
      redirectUri: REDIRECT,
      url: BASE,
      fetch: () => Promise.reject(new TypeError("offline")),
    });
    expect(await rejection(client.listProjects("at"))).toMatchObject({
      code: "unreachable",
    });
  });
});

describe("bearerChallenge", () => {
  it("reads quoted and token parameters with lower-case names", () => {
    expect(
      bearerChallenge(
        'Bearer realm="permdock", ERROR="insufficient_scope", scope="projects:read policy:read"',
      ),
    ).toEqual({
      scheme: "bearer",
      params: {
        realm: "permdock",
        error: "insufficient_scope",
        scope: "projects:read policy:read",
      },
    });
    expect(bearerChallenge("bearer error=invalid_token")).toEqual({
      scheme: "bearer",
      params: { error: "invalid_token" },
    });
  });

  it("skips other schemes and unescapes quoted pairs", () => {
    expect(
      bearerChallenge(
        'Basic realm="x", Negotiate abc==, Bearer error_description="a \\"b\\""',
      ),
    ).toEqual({ scheme: "bearer", params: { error_description: 'a "b"' } });
  });

  it("answers null without a Bearer challenge", () => {
    expect(bearerChallenge(null)).toBeNull();
    expect(bearerChallenge('Basic realm="x"')).toBeNull();
    expect(bearerChallenge("")).toBeNull();
    expect(bearerChallenge("=")).toBeNull();
  });
});
