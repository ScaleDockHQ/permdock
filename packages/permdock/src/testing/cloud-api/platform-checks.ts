import { expect, it } from "vitest";

import { catalogFingerprint } from "../../core/catalog-fingerprint.ts";
import { isRecord } from "../../core/compact.ts";
import { discoverAuthorizationServer } from "../../terminal/device.ts";
import { PLATFORM_SCOPES, POLICY_NOT_PUBLISHED } from "./platform.ts";

export type TestCloudPlatformOptions = {
  /** A `PERMDOCK_CLOUD_TOKEN` for `project`: read-only, pinned to one environment. */
  readonly token: string;
  /** The project the token reads; defaults to the environment. */
  readonly project?: string;
  /** A project with no `cloud push` yet and a login token that reads it; the `policy-not-published` check is skipped without it. */
  readonly unpublished?: {
    readonly project: string;
    readonly token: string;
  };
  /** Registers a test MCP client with RFC 7591; skipped unless true. */
  readonly registration?: boolean;
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const ITEM = /^"[^"]+"(?:;[a-z]+=-?\d+)+$/u;

/** Whether a RateLimit or RateLimit-Policy field value lists items with the parameters `keys` (draft-ietf-httpapi-ratelimit-headers-11). */
function rateLimitField(
  value: string | null,
  keys: readonly string[],
): boolean {
  if (value === null || value.trim() === "") {
    return false;
  }
  return value.split(",").every((raw) => {
    const item = raw.trim();
    return ITEM.test(item) && keys.every((key) => item.includes(`;${key}=`));
  });
}

function rateLimited(response: Response): boolean {
  return (
    rateLimitField(response.headers.get("ratelimit"), ["r", "t"]) &&
    rateLimitField(response.headers.get("ratelimit-policy"), ["q", "w"])
  );
}

function problemType(response: Response, body: unknown): unknown {
  return (response.headers.get("content-type") ?? "").startsWith(
    "application/problem+json",
  ) && isRecord(body)
    ? body["type"]
    : undefined;
}

/** The platform issuer and project read API checks of `testCloudApi`. */
export function testCloudPlatform(
  url: string,
  environment: string,
  options: TestCloudPlatformOptions,
  fetchFn: Fetch,
): void {
  const project = options.project ?? environment;
  const read = (path: string, token: string | null): Promise<Response> =>
    fetchFn(
      `${url}${path}`,
      token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
  const form = (path: string, fields: Readonly<Record<string, string>>) =>
    fetchFn(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  it("publishes RFC 8414 metadata for the platform issuer", async () => {
    const metadata = await discoverAuthorizationServer(url, {
      fetch: (input, init) => fetchFn(String(input), init),
    });
    expect(metadata).not.toBeNull();
    expect(metadata).toMatchObject({
      issuer: url,
      code_challenge_methods_supported: ["S256"],
    });
    const scopes = metadata?.["scopes_supported"];
    expect(scopes).toEqual(
      expect.arrayContaining(Object.keys(PLATFORM_SCOPES)),
    );
  });

  it("lists and reads the project and its policy with RateLimit fields", async () => {
    const list = await read("/v1/projects", options.token);
    expect(list.status).toBe(200);
    expect(rateLimited(list)).toBe(true);
    const listed: unknown = await list.json();
    const items =
      isRecord(listed) && Array.isArray(listed["items"]) ? listed["items"] : [];
    expect(items).toContainEqual(expect.objectContaining({ id: project }));

    const one = await read(
      `/v1/projects/${encodeURIComponent(project)}`,
      options.token,
    );
    expect(one.status).toBe(200);
    expect(rateLimited(one)).toBe(true);
    expect(await one.json()).toMatchObject({
      id: project,
      environment: project,
    });

    const policy = await read(
      `/v1/projects/${encodeURIComponent(project)}/policy`,
      options.token,
    );
    const body: unknown = await policy.json();
    if (policy.status === 404) {
      expect(problemType(policy, body)).toBe(POLICY_NOT_PUBLISHED);
      return;
    }
    expect(policy.status).toBe(200);
    expect(rateLimited(policy)).toBe(true);
    expect(isRecord(body)).toBe(true);
    const catalog = isRecord(body) ? body["catalog"] : undefined;
    expect(isRecord(catalog)).toBe(true);
    const fingerprint = isRecord(catalog) ? catalogFingerprint(catalog) : "";
    expect(body).toMatchObject({ v: 1, project, fingerprint });
  });

  it("answers policy-not-published as Problem Details before the first push", async (context) => {
    if (options.unpublished === undefined) {
      context.skip();
      return;
    }
    const response = await read(
      `/v1/projects/${encodeURIComponent(options.unpublished.project)}/policy`,
      options.unpublished.token,
    );
    expect(response.status).toBe(404);
    expect(problemType(response, await response.json())).toBe(
      POLICY_NOT_PUBLISHED,
    );
  });

  it("answers 401 Problem Details to the read API without a token", async () => {
    const response = await read(
      `/v1/projects/${encodeURIComponent(project)}`,
      null,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toMatch(
      /^application\/problem\+json/u,
    );
  });

  it("refuses a catalog push with the read-only token", async () => {
    const response = await fetchFn(
      `${url}/v1/environments/${encodeURIComponent(project)}/catalog`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ fingerprint: "x", catalog: {} }),
      },
    );
    expect([401, 403]).toContain(response.status);
  });

  it("answers RFC 7009 revocation of an unknown token with 200", async () => {
    const response = await form("/oauth/revoke", {
      token: `unknown-${globalThis.crypto.randomUUID()}`,
      token_type_hint: "refresh_token",
      client_id: "permdock-cli",
    });
    expect(response.status).toBe(200);
  });

  it("registers an MCP client with a loopback redirect and refuses a plain http one", async (context) => {
    if (options.registration !== true) {
      context.skip();
      return;
    }
    const register = (redirect: string) =>
      fetchFn(`${url}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          client_name: "PermDock contract test",
        }),
      });
    const loopback = await register("http://127.0.0.1:33418/callback");
    expect(loopback.status).toBe(201);
    expect(await loopback.json()).toMatchObject({
      client_id: expect.any(String),
    });
    expect((await register("http://mcp.example.invalid/callback")).status).toBe(
      400,
    );
  });
}
