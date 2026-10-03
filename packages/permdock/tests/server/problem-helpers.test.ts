import { describe, expect, it } from "vitest";

import type { Decision, Denial } from "../../src/core/decision.ts";
import type { Subject } from "../../src/core/subject.ts";

import { PermDockValidationError } from "../../src/core/errors.ts";
import { createPermDock as createCorePermDock } from "../../src/core/permdock.ts";
import {
  bearerChallenge,
  problemFromDecision,
  protectedResourceMetadataUrl,
  rateLimitHeaders,
  stepUpOf,
  validationProblem,
  wwwAuthenticate,
} from "../../src/server/problem.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const SUBJECT: Subject = {
  principal: { id: "u1", roles: ["member"] },
  context: {},
};

function denied(...denials: Denial[]): Decision {
  return { outcome: "denied", denials, alternatives: [] };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  // SAFETY: every problem response read here is a JSON object.
  return (await response.json()) as Record<string, unknown>;
}

describe("bearerChallenge", () => {
  it("writes every parameter, deduplicating scopes and dropping quotes", () => {
    expect(
      bearerChallenge({
        error: "insufficient_scope",
        description: 'say "hi"',
        scopes: ["a", "b", "a"],
        acrValues: ["gold"],
        maxAge: 60,
        resourceMetadata:
          "https://api.example/.well-known/oauth-protected-resource",
      }),
    ).toBe(
      'Bearer error="insufficient_scope", error_description="say hi", scope="a b", acr_values="gold", max_age="60", resource_metadata="https://api.example/.well-known/oauth-protected-resource"',
    );
    expect(
      bearerChallenge({ error: "invalid_token", scopes: [], acrValues: [] }),
    ).toBe('Bearer error="invalid_token"');
  });

  it("builds the RFC 9728 metadata URL", () => {
    expect(protectedResourceMetadataUrl(new URL("https://api.example/"))).toBe(
      "https://api.example/.well-known/oauth-protected-resource",
    );
    expect(
      protectedResourceMetadataUrl(new URL("https://api.example/v1/mcp")),
    ).toBe("https://api.example/.well-known/oauth-protected-resource/v1/mcp");
  });
});

describe("stepUpOf and wwwAuthenticate", () => {
  it("collects acr values and the tightest max age from assurance grantees", () => {
    const decision = denied(
      { role: "a", reason: "no-grant" },
      { role: "b", reason: "insufficient-user-authentication" },
      {
        role: "c",
        reason: "insufficient-user-authentication",
        to: { kind: "assurance", acr: ["silver"], maxAge: 600 },
      },
      {
        role: "d",
        reason: "insufficient-user-authentication",
        to: [
          { kind: "role", role: "admin", scope: "tenant" },
          { kind: "assurance", acr: ["gold", "silver"], maxAge: 300 },
          { kind: "assurance" },
        ],
      },
    );
    expect(stepUpOf(decision)).toEqual({
      acrValues: ["silver", "gold"],
      maxAge: 300,
    });
    expect(
      stepUpOf(
        denied({ role: null, reason: "insufficient-user-authentication" }),
      ),
    ).toEqual({});
    // SAFETY: stepUpOf returns early on any outcome but denied, before reading another field.
    expect(
      stepUpOf({ outcome: "approval-required" } as unknown as Decision),
    ).toEqual({});
    expect(wwwAuthenticate(decision, undefined)).toBe(
      'Bearer error="insufficient_user_authentication", acr_values="silver gold", max_age="300"',
    );
  });

  it.each<[string, Decision, boolean, string | undefined]>([
    [
      "anonymous with credentials",
      denied({ role: null, reason: "anonymous" }),
      true,
      'Bearer error="invalid_token", error_description="The access token is invalid"',
    ],
    [
      "anonymous without credentials",
      denied({ role: null, reason: "anonymous" }),
      false,
      "Bearer",
    ],
    [
      "not-delegated",
      denied({ role: null, reason: "not-delegated" }),
      true,
      'Bearer error="insufficient_scope", scope="post:update"',
    ],
    [
      "no-delegation",
      denied({ role: null, reason: "no-delegation" }),
      true,
      'Bearer error="insufficient_scope", scope="post:update"',
    ],
    [
      "a plain denial",
      denied({ role: null, reason: "no-grant" }),
      true,
      undefined,
    ],
  ])("challenges %s", (_label, decision, credentials, header) => {
    expect(
      wwwAuthenticate(decision, permissions.post.update, credentials),
    ).toBe(header);
  });

  it("omits the scope when no permission is known", () => {
    expect(
      wwwAuthenticate(
        denied({ role: null, reason: "no-delegation" }),
        undefined,
      ),
    ).toBe('Bearer error="insufficient_scope"');
  });
});

describe("rateLimitHeaders", () => {
  it("names one policy per role, percent-encodes non-ASCII and escapes quotes", () => {
    const detail = { count: 5, window: 60, resetsAt: 1_000 };
    const headers = rateLimitHeaders(
      denied(
        { role: 'r\u00E9le "x"', reason: "limit", detail },
        {
          role: 'r\u00E9le "x"',
          reason: "limit",
          detail: { ...detail, resetsAt: 2_000 },
        },
        {
          role: null,
          reason: "limit",
          detail: { count: 1, window: 1, resetsAt: 990 },
        },
        { role: "bad", reason: "limit", detail: { count: "x" } },
        { role: "none", reason: "limit", detail: null },
        { role: "other", reason: "no-grant" },
      ),
      980,
    );
    expect(headers).toEqual({
      "Retry-After": "10",
      RateLimit: '"r%C3%A9le \\"x\\"";r=0;t=20, "default";r=0;t=10',
      "RateLimit-Policy": '"r%C3%A9le \\"x\\"";q=5;w=60, "default";q=1;w=1',
    });
    expect(
      rateLimitHeaders(denied({ role: null, reason: "no-grant" })),
    ).toEqual({});
    // SAFETY: rateLimitHeaders returns early on any outcome but denied, before reading another field.
    expect(
      rateLimitHeaders({ outcome: "granted" } as unknown as Decision),
    ).toEqual({});
  });
});

describe("problemFromDecision", () => {
  it("answers 204 for a granted decision", async () => {
    const permdock = await createCorePermDock(policy, memberUser);
    const decision = permdock.decide(permissions.post.read, ownPost);
    expect(
      problemFromDecision(decision, permissions.post.read, SUBJECT).status,
    ).toBe(204);
  });

  it("carries the approval hint only when it names something", async () => {
    const permdock = await createCorePermDock(policy, memberUser);
    const decision = permdock.decide(permissions.post.delete, ownPost);
    const hinted = await body(
      problemFromDecision(decision, permissions.post.delete, SUBJECT, {
        approval: { at: "https://app.example/approvals", hint: "ask an admin" },
        instance: "/posts/p1",
      }),
    );
    expect(hinted).toMatchObject({
      type: expect.stringMatching(/approval-required$/u),
      instance: "/posts/p1",
      approval: { at: "https://app.example/approvals", hint: "ask an admin" },
    });
    const empty = await body(
      problemFromDecision(decision, permissions.post.delete, SUBJECT, {
        approval: {},
      }),
    );
    expect(empty).not.toHaveProperty("approval");
  });

  it("answers a validation denial with the validation problem", async () => {
    const error = new PermDockValidationError({
      code: "invalid-data",
      permission: "post.update",
      resource: "post",
      boundary: "http-body",
      message: "bad body",
      issues: [],
    });
    const response = problemFromDecision(
      denied({ role: null, reason: "validation", detail: error }),
      permissions.post.update,
      SUBJECT,
    );
    expect(response.status).toBe(error.toProblemDetails().status);
    expect(await body(response)).toMatchObject({
      type: error.toProblemDetails().type,
    });
  });

  it("answers an anonymous denial with a bare challenge when no credentials were sent", () => {
    const response = problemFromDecision(
      denied({ role: null, reason: "anonymous" }),
      permissions.post.update,
      { principal: null, context: {} },
      { credentials: false },
    );
    expect({
      status: response.status,
      challenge: response.headers.get("www-authenticate"),
    }).toEqual({
      status: 401,
      challenge: "Bearer",
    });
  });

  it("answers a validation problem helper with 400", async () => {
    const response = validationProblem("nope");
    expect({
      status: response.status,
      body: await body(response),
    }).toMatchObject({
      status: 400,
      body: { title: "Invalid request", detail: "nope" },
    });
  });
});
