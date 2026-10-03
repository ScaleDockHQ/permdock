import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { JwtSubjectOptions } from "../../src/jwt/index.ts";

import { compact } from "../../src/core/compact.ts";
import { assurance } from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy } from "../../src/core/policy.ts";
import {
  createJwtSubjectResolver,
  subjectFromJwt,
} from "../../src/jwt/subject.ts";
import { problemFromDecision } from "../../src/server/problem.ts";
import { BACKCHANNEL_LOGOUT_EVENT } from "../../src/ssf/events.ts";
import { createPermDock as createSsf } from "../../src/ssf/index.ts";

const ISSUER = "https://login.example.com";
const API = "https://api.example.com";
const CLIENT = "web-app";
const NOW = Math.floor(Date.now() / 1000);

let privateJwk: Record<string, unknown>;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: "op-1" };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "op-1" };
});

async function token(
  claims: Record<string, unknown>,
  options: {
    readonly typ?: string;
    readonly audience?: string | string[];
    readonly iat?: boolean;
    readonly issuer?: string;
  } = {},
): Promise<string> {
  const jwt = new SignJWT({ sub: "u_1", ...claims })
    .setProtectedHeader({
      alg: "ES256",
      kid: "op-1",
      typ: options.typ ?? "at+jwt",
    })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? API)
    .setExpirationTime(NOW + 300);
  if (options.iat !== false) {
    jwt.setIssuedAt(NOW);
  }
  return jwt.sign(await importJWK(privateJwk, "ES256"));
}

function local(
  causes: string[] = [],
  overrides: Partial<JwtSubjectOptions> = {},
): JwtSubjectOptions {
  return {
    jwks: { keys: [publicJwk] },
    issuer: ISSUER,
    audience: API,
    onAuth: (event) => {
      causes.push(String(event.cause));
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that serves `documents` by URL and records every request. */
function served(documents: Readonly<Record<string, unknown>>): {
  readonly fetch: typeof fetch;
  readonly seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push(url);
      const body = documents[url];
      return body === undefined ? json({}, 404) : json(body);
    },
  };
}

describe("OpenID Connect Discovery 1.0 and RFC 8414", () => {
  it("section 4: reads /.well-known/openid-configuration and its jwks_uri", async () => {
    const { fetch, seen } = served({
      [`${ISSUER}/.well-known/openid-configuration`]: {
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/keys`,
      },
      [`${ISSUER}/keys`]: { keys: [publicJwk] },
    });
    const resolve = createJwtSubjectResolver({
      discovery: ISSUER,
      audience: API,
      fetch,
    });
    expect((await resolve(await token({}))).principal?.id).toBe("u_1");
    expect((await resolve(await token({}))).principal?.id).toBe("u_1");
    expect(seen).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/keys`,
    ]);
  });

  it("section 4: an issuer with a path appends the well-known suffix", async () => {
    const tenantIssuer = `${ISSUER}/tenant-a`;
    const { fetch, seen } = served({
      [`${tenantIssuer}/.well-known/openid-configuration`]: {
        issuer: tenantIssuer,
        jwks_uri: `${ISSUER}/keys`,
      },
      [`${ISSUER}/keys`]: { keys: [publicJwk] },
    });
    const subject = await subjectFromJwt(
      await token({}, { issuer: tenantIssuer }),
      { discovery: tenantIssuer, audience: API, fetch },
    );
    expect(subject.principal?.issuer).toBe(tenantIssuer);
    expect(seen[0]).toBe(`${tenantIssuer}/.well-known/openid-configuration`);
  });

  it("RFC 8414 section 3.1: falls back to the path-inserted authorization server metadata", async () => {
    const tenantIssuer = `${ISSUER}/tenant-a`;
    const { fetch, seen } = served({
      [`${ISSUER}/.well-known/oauth-authorization-server/tenant-a`]: {
        issuer: tenantIssuer,
        jwks_uri: `${ISSUER}/keys`,
      },
      [`${ISSUER}/keys`]: { keys: [publicJwk] },
    });
    const subject = await subjectFromJwt(
      await token({}, { issuer: tenantIssuer }),
      { discovery: tenantIssuer, audience: API, fetch },
    );
    expect(subject.principal?.id).toBe("u_1");
    expect(seen.slice(0, 2)).toEqual([
      `${tenantIssuer}/.well-known/openid-configuration`,
      `${ISSUER}/.well-known/oauth-authorization-server/tenant-a`,
    ]);
  });

  it("section 4.3: a document whose issuer differs is refused", async () => {
    const causes: string[] = [];
    const { fetch } = served({
      [`${ISSUER}/.well-known/openid-configuration`]: {
        issuer: "https://evil.example.com",
        jwks_uri: `${ISSUER}/keys`,
      },
      [`${ISSUER}/keys`]: { keys: [publicJwk] },
    });
    const subject = await subjectFromJwt(await token({}), {
      discovery: ISSUER,
      audience: API,
      fetch,
      onAuth: (event) => {
        causes.push(String(event.cause));
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["discovery-mismatch"]);
  });

  it("section 3: a jwks_uri that is not https is never fetched", async () => {
    const causes: string[] = [];
    const { fetch, seen } = served({
      [`${ISSUER}/.well-known/openid-configuration`]: {
        issuer: ISSUER,
        jwks_uri: "http://login.example.com/keys",
      },
      "http://login.example.com/keys": { keys: [publicJwk] },
    });
    const subject = await subjectFromJwt(await token({}), {
      discovery: ISSUER,
      audience: API,
      fetch,
      onAuth: (event) => {
        causes.push(String(event.cause));
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["discovery-unavailable"]);
    expect(seen).not.toContain("http://login.example.com/keys");
    expect(() =>
      createJwtSubjectResolver({
        discovery: {
          issuer: ISSUER,
          metadata: { jwks_uri: "http://login.example.com/keys" },
        },
        audience: API,
      }),
    ).toThrow(/jwks_uri must use https/u);
  });

  it("section 3: an http issuer, a second issuer or jwks next to discovery is a configuration error", () => {
    expect(() =>
      createJwtSubjectResolver({ discovery: "http://login.example.com" }),
    ).toThrow(/https/u);
    expect(() =>
      createJwtSubjectResolver({
        discovery: ISSUER,
        issuer: "https://other.example.com",
      }),
    ).toThrow(/issuer must match/u);
    expect(() =>
      createJwtSubjectResolver({
        discovery: ISSUER,
        jwks: { keys: [] },
      }),
    ).toThrow(/mutually exclusive/u);
  });
});

describe("OpenID Connect Core 1.0: access tokens and ID tokens", () => {
  it("a token carrying nonce is an ID token and never authorises an API", async () => {
    const causes: string[] = [];
    const subject = await subjectFromJwt(
      await token({ nonce: "n-1" }, { typ: "JWT" }),
      local(causes),
    );
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["wrong-token-type"]);
  });

  it("section 3.1.3.7: accept 'id-token' verifies aud, iss and exp and drops delegation", async () => {
    const subject = await subjectFromJwt(
      await token(
        { nonce: "n-1", scope: "admin" },
        { typ: "JWT", audience: CLIENT },
      ),
      local([], { audience: CLIENT, accept: "id-token" }),
    );
    expect(subject.principal?.id).toBe("u_1");
    expect(subject.delegation).toBeUndefined();
    for (const [claims, audience] of [
      [{}, "other-client"],
      [{ iss: "https://evil.example.com" }, CLIENT],
    ] as const) {
      const causes: string[] = [];
      const forged = await subjectFromJwt(
        await token(claims, {
          typ: "JWT",
          audience,
          issuer: "iss" in claims ? claims.iss : ISSUER,
        }),
        local(causes, { audience: CLIENT, accept: "id-token" }),
      );
      expect(forged.principal).toBeNull();
      expect(causes).toHaveLength(1);
    }
  });

  it("section 3.1.3.7: accept 'id-token' refuses an at+jwt", async () => {
    const causes: string[] = [];
    const subject = await subjectFromJwt(
      await token({}, { typ: "at+jwt", audience: CLIENT }),
      local(causes, { audience: CLIENT, accept: "id-token" }),
    );
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["wrong-token-type"]);
  });

  it("section 2: an ID token without iat is refused", async () => {
    const causes: string[] = [];
    const subject = await subjectFromJwt(
      await token({}, { typ: "JWT", audience: CLIENT, iat: false }),
      local(causes, { audience: CLIENT, accept: "id-token" }),
    );
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["wrong-token-type"]);
  });

  it("section 3.1.3.7 points 4 and 5: azp is required with several audiences and must be the client", async () => {
    const options = { audience: CLIENT, accept: "id-token" } as const;
    const cases = [
      { claims: {}, audience: [CLIENT, "other"], ok: false },
      { claims: { azp: "other" }, audience: [CLIENT, "other"], ok: false },
      { claims: { azp: CLIENT }, audience: [CLIENT, "other"], ok: true },
      { claims: { azp: "other" }, audience: CLIENT, ok: false },
      { claims: { azp: CLIENT }, audience: CLIENT, ok: true },
    ];
    for (const { claims, audience, ok } of cases) {
      const subject = await subjectFromJwt(
        await token(claims, { typ: "JWT", audience }),
        local([], options),
      );
      expect({ claims, audience, ok: subject.principal !== null }).toEqual({
        claims,
        audience,
        ok,
      });
    }
  });
});

describe("OpenID Connect Core 1.0: claims that reach the principal", () => {
  it("maps sub, iss, acr, amr, auth_time, sid and session_expiry", async () => {
    const subject = await subjectFromJwt(
      await token({
        acr: "urn:example:loa:2",
        amr: ["pwd", "otp"],
        auth_time: NOW - 60,
        sid: "sess-1",
        session_expiry: NOW + 100,
      }),
      local(),
    );
    expect(subject.principal).toMatchObject({
      id: "u_1",
      issuer: ISSUER,
      assurance: {
        acr: "urn:example:loa:2",
        amr: ["pwd", "otp"],
        authTime: NOW - 60,
      },
    });
    expect(subject.session).toBe("sess-1");
    expect(subject.expiresAt).toBe(NOW + 100);
  });

  it("expiresAt is exp when session_expiry is later or absent", async () => {
    const later = await subjectFromJwt(
      await token({ session_expiry: NOW + 9999 }),
      local(),
    );
    expect(later.expiresAt).toBe(NOW + 300);
    expect((await subjectFromJwt(await token({}), local())).expiresAt).toBe(
      NOW + 300,
    );
  });

  it("section 5.1: profile claims never reach the principal", async () => {
    const subject = await subjectFromJwt(
      await token({
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        picture: "https://example.com/ada.png",
        preferred_username: "admin",
        department: "r-and-d",
      }),
      local(),
    );
    expect(subject.principal?.claims).toEqual({ department: "r-and-d" });
    expect(subject.principal?.roles).toBeUndefined();
  });

  it("section 2: sub is opaque and compared byte for byte", async () => {
    const subject = await subjectFromJwt(await token({ sub: "U_1 " }), local());
    expect(subject.principal?.id).toBe("U_1 ");
    const empty = await subjectFromJwt(await token({ sub: "" }), local());
    expect(empty.principal).toBeNull();
  });

  it("OpenID Connect for Identity Assurance: verified_claims becomes assurance.verified", async () => {
    const entry = {
      verification: { trust_framework: "eidas", assurance_level: "high" },
      claims: { given_name: "Ada" },
    };
    const subject = await subjectFromJwt(
      await token({
        verified_claims: [
          entry,
          { verification: {}, claims: {} },
          {
            verification: { trust_framework: "x" },
            claims: { constructor: 1 },
          },
        ],
      }),
      local(),
    );
    expect(subject.principal?.assurance?.verified).toEqual([entry]);
    expect(Object.isFrozen(subject.principal?.assurance?.verified)).toBe(true);
  });
});

describe("RFC 9470 OAuth 2.0 Step Up Authentication Challenge", () => {
  const permissions = definePermissions({
    payout: resource(z.object({ id: z.string() }), {
      id: "id",
      actions: ["create"],
    }),
  });
  const policy = definePolicy(permissions, {
    principal: () => null,
    grants: [
      allow(permissions.payout.create, {
        to: assurance({ acr: ["urn:example:loa:3"], maxAge: 300 }),
      }),
    ],
  });

  it("section 3: a stale or weak login is denied with the step-up challenge", async () => {
    const subject = await subjectFromJwt(
      await token({ acr: "urn:example:loa:2", auth_time: NOW - 600 }),
      local(),
    );
    const permdock = await createPermDock(policy, subject);
    const decision = permdock.decide(
      permissions.payout.create,
      { id: "p1" },
      {
        now: NOW,
      },
    );
    expect(decision).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "insufficient-user-authentication" }],
    });
    const response = problemFromDecision(
      decision,
      permissions.payout.create,
      permdock.subject,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="urn:example:loa:3", max_age="300"',
    );
    expect(await response.json()).toMatchObject({
      type: "https://permdock.dev/problems/step-up-required",
      acrValues: ["urn:example:loa:3"],
      maxAge: 300,
    });
  });

  it("section 4: a fresh login at the required acr is granted", async () => {
    const subject = await subjectFromJwt(
      await token({ acr: "urn:example:loa:3", auth_time: NOW - 10 }),
      local(),
    );
    const permdock = await createPermDock(policy, subject);
    expect(
      permdock.decide(permissions.payout.create, { id: "p1" }, { now: NOW })
        .outcome,
    ).toBe("granted");
  });
});

describe("OpenID Connect Back-Channel Logout 1.0", () => {
  const permissions = definePermissions({
    post: resource(z.object({ id: z.string() }), {
      id: "id",
      actions: ["read"],
    }),
  });
  const policy = definePolicy(permissions, {
    principal: () => null,
    grants: [],
  });

  async function logoutToken(
    claims: Record<string, unknown>,
    typ = "logout+jwt",
  ): Promise<string> {
    return new SignJWT({
      sub: "u_1",
      sid: "sess-1",
      jti: crypto.randomUUID(),
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "op-1", typ })
      .setIssuer(ISSUER)
      .setAudience(CLIENT)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 120)
      .sign(await importJWK(privateJwk, "ES256"));
  }

  function receiver(seen: string[]) {
    return createSsf(policy, {
      issuer: ISSUER,
      audience: CLIENT,
      jwks: { keys: [publicJwk] },
      subject: (setSubject, meta) =>
        compact({
          id: String(setSubject["sub"] ?? setSubject["id"]),
          session: meta?.session,
          issuer: meta?.issuer,
        }),
      onEvent: {
        "session-revoked": ({ subject }) => {
          seen.push(
            `${String(subject.issuer)} ${subject.id} ${String(subject.session)}`,
          );
        },
      },
    }).receiver;
  }

  function post(logout: string): Request {
    return new Request("https://app.example.com/oidc/logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logout }).toString(),
    });
  }

  it("section 2.8: a valid logout_token revokes the session and answers 200", async () => {
    const seen: string[] = [];
    const response = await receiver(seen).logout(post(await logoutToken({})));
    expect(response.status).toBe(200);
    expect(seen).toEqual([`${ISSUER} u_1 sess-1`]);
  });

  it("section 2.6: a logout_token is refused without the event, with nonce, without sub and sid, or with another typ", async () => {
    const seen: string[] = [];
    const handle = receiver(seen);
    const refused = [
      await logoutToken({ events: {} }),
      await logoutToken({ nonce: "n-1" }),
      await logoutToken({ sub: undefined, sid: undefined }),
      await logoutToken({}, "secevent+jwt"),
      await logoutToken({ jti: undefined }),
    ];
    for (const logout of refused) {
      const response = await handle.logout(post(logout));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(seen).toEqual([]);
  });

  it("section 2.6: a replayed jti revokes once", async () => {
    const seen: string[] = [];
    const handle = receiver(seen);
    const logout = await logoutToken({});
    expect((await handle.logout(post(logout))).status).toBe(200);
    expect((await handle.logout(post(logout))).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("section 2.5: the logout endpoint takes a form POST only", async () => {
    const handle = receiver([]);
    const logout = await logoutToken({});
    const asJson = new Request("https://app.example.com/oidc/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logout_token: logout }),
    });
    expect((await handle.logout(asJson)).status).toBe(400);
    const asGet = new Request(
      `https://app.example.com/oidc/logout?logout_token=${logout}`,
    );
    expect((await handle.logout(asGet)).status).toBe(400);
  });
});
