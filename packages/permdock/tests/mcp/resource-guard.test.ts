import { describe, expect, it } from "vitest";

import type { TokenVerifier, VerifiedToken } from "../../src/index.ts";

import {
  mcpResourceGuard,
  protectedResourceMetadata,
} from "../../src/mcp/index.ts";

const RESOURCE = "https://api.example.com/mcp";
const METADATA =
  "https://api.example.com/.well-known/oauth-protected-resource/mcp";

const tokens: Record<string, VerifiedToken["claims"]> = {
  full: {
    sub: "user_1",
    client_id: "client_1",
    scope: "post:read post:write",
    exp: 2_000_000_000,
  },
  narrow: { sub: "user_1", azp: "client_2", scp: ["post:read"] },
};

function verifier(seen: unknown[] = []): TokenVerifier {
  return {
    verify(token, expectations) {
      seen.push(expectations);
      const claims = tokens[token];
      return Promise.resolve(
        claims === undefined
          ? { ok: false, reason: "invalid-token", cause: "invalid-signature" }
          : { ok: true, claims, header: { alg: "ES256" } },
      );
    },
  };
}

function request(authorization?: string): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe(mcpResourceGuard, () => {
  it("answers McpAuthInfo for a token with every required scope", async () => {
    const seen: unknown[] = [];
    const guard = mcpResourceGuard({
      resource: RESOURCE,
      scopes: ["post:read"],
      verifier: verifier(seen),
      issuer: "https://auth.example.com",
    });
    const result = await guard(request("Bearer full"));
    expect(seen).toStrictEqual([
      { audience: RESOURCE, issuer: "https://auth.example.com" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.authInfo).toMatchObject({
      token: "full",
      clientId: "client_1",
      scopes: ["post:read", "post:write"],
      expiresAt: 2_000_000_000,
      resourceMetadataUrl: METADATA,
      extra: { claims: tokens["full"] },
    });
    expect(result.authInfo.resource?.href).toBe(RESOURCE);
  });

  it("reads scp and azp", async () => {
    const result = await mcpResourceGuard({
      resource: RESOURCE,
      verifier: verifier(),
    })(request("bearer narrow"));
    expect(result.ok && result.authInfo).toMatchObject({
      clientId: "client_2",
      scopes: ["post:read"],
    });
  });

  it("answers 401 with a bare challenge when no token is sent", async () => {
    const result = await mcpResourceGuard({
      resource: RESOURCE,
      verifier: verifier(),
    })(request());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA}"`,
    );
    expect(result.response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it.each([
    ["an unknown token", "Bearer nope"],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["a malformed header", "Bearer a b"],
  ])("answers 401 invalid_token for %s", async (_, authorization) => {
    const result = await mcpResourceGuard({
      resource: RESOURCE,
      verifier: verifier(),
    })(request(authorization));
    expect(!result.ok && result.response.status).toBe(401);
    expect(!result.ok && result.response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="The access token is invalid", resource_metadata="${METADATA}"`,
    );
  });

  it("refuses a revoked token and one whose revocation check throws", async () => {
    for (const revoked of [
      (): boolean => true,
      (): boolean => {
        throw new Error("feed down");
      },
    ]) {
      const result = await mcpResourceGuard({
        resource: RESOURCE,
        verifier: verifier(),
        revoked,
      })(request("Bearer full"));
      expect(!result.ok && result.response.status).toBe(401);
    }
  });

  it("refuses when the verifier throws", async () => {
    const result = await mcpResourceGuard({
      resource: RESOURCE,
      verifier: { verify: () => Promise.reject(new Error("jwks down")) },
    })(request("Bearer full"));
    expect(!result.ok && result.response.status).toBe(401);
  });

  it("answers 403 insufficient_scope naming every required scope", async () => {
    const result = await mcpResourceGuard({
      resource: RESOURCE,
      scopes: ["post:read", "post:write"],
      verifier: verifier(),
      resourceMetadataUrl: "https://meta.example.com/prm",
    })(request("Bearer narrow"));
    expect(!result.ok && result.response.status).toBe(403);
    expect(!result.ok && result.response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="post:read post:write", resource_metadata="https://meta.example.com/prm"',
    );
  });
});

describe(protectedResourceMetadata, () => {
  const handler = protectedResourceMetadata({
    resource: RESOURCE,
    authorizationServers: ["https://auth.example.com"],
    scopesSupported: ["post:read", "post:write"],
    resourceName: "Posts",
  });

  it("serves the RFC 9728 document to any origin", async () => {
    const response = handler(new Request(METADATA));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toStrictEqual({
      resource: RESOURCE,
      authorization_servers: ["https://auth.example.com"],
      scopes_supported: ["post:read", "post:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Posts",
    });
  });

  it("answers a preflight and refuses other methods", () => {
    expect(handler(new Request(METADATA, { method: "OPTIONS" })).status).toBe(
      204,
    );
    const post = handler(new Request(METADATA, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
