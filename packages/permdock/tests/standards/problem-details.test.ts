import { readFileSync } from "node:fs";
import path from "node:path";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { Decision, Denial } from "../../src/core/decision.ts";
import type { ProblemType } from "../../src/core/problem-types.ts";

import {
  approvalsHandler,
  memoryApprovalStore,
} from "../../src/approvals/index.ts";
import { PermDockValidationError } from "../../src/core/errors.ts";
import {
  PROBLEM_TYPES,
  problemType,
  statusProblem,
} from "../../src/core/problem-types.ts";
import {
  PROBLEM_BASE,
  createPermDock,
  problemFromDecision,
} from "../../src/server/index.ts";
import { methodNotAllowed } from "../../src/server/problem.ts";
import { invalidSignatureProblem } from "../../src/server/web-bot-auth.ts";
import { PROBLEM_EXAMPLES } from "../../src/testing/problem-examples.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

const at = (seconds: number): string => new Date(seconds * 1000).toISOString();

const subject = { principal: null, context: {} };
const permission = permissions.post.update;

function denied(...denials: readonly Denial[]): Decision {
  return { outcome: "denied", denials, alternatives: [permissions.post.read] };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  expect(parsed).toBeTypeOf("object");
  // SAFETY: checked to be an object above; every Problem Details body is a JSON object.
  return parsed as Record<string, unknown>;
}

describe("RFC 9457 Problem Details", () => {
  const rows: readonly {
    readonly name: string;
    readonly decision: Decision;
    readonly status: number;
    readonly type: string;
    readonly challenge: string | null;
    readonly disclosure?: "hide";
  }[] = [
    {
      name: "a token that failed verification",
      decision: denied({ role: null, reason: "anonymous" }),
      status: 401,
      type: "about:blank",
      challenge:
        'Bearer error="invalid_token", error_description="The access token is invalid"',
    },
    {
      name: "a token without the delegated scope",
      decision: denied({ role: "member", reason: "not-delegated" }),
      status: 403,
      type: "denied",
      challenge: `Bearer error="insufficient_scope", scope="${permission.scope}"`,
    },
    {
      name: "a delegation-free token",
      decision: denied({ role: "member", reason: "no-delegation" }),
      status: 403,
      type: "denied",
      challenge: `Bearer error="insufficient_scope", scope="${permission.scope}"`,
    },
    {
      name: "a step-up",
      decision: denied(
        {
          role: "member",
          reason: "insufficient-user-authentication",
          to: { kind: "assurance", acr: ["urn:mfa"], maxAge: 600 },
        },
        {
          role: "admin",
          reason: "insufficient-user-authentication",
          to: [{ kind: "assurance", acr: ["urn:hwk"], maxAge: 300 }],
        },
      ),
      status: 401,
      type: "step-up-required",
      challenge:
        'Bearer error="insufficient_user_authentication", acr_values="urn:mfa urn:hwk", max_age="300"',
    },
    {
      name: "only plan denials",
      decision: denied({
        role: "admin",
        reason: "not-entitled",
        to: { kind: "plan", plan: "pro" },
      }),
      status: 403,
      type: "not-entitled",
      challenge: null,
    },
    {
      name: "a plan denial mixed with another reason",
      decision: denied(
        {
          role: "admin",
          reason: "not-entitled",
          to: { kind: "plan", plan: "pro" },
        },
        { role: "member", reason: "condition" },
      ),
      status: 403,
      type: "denied",
      challenge: null,
    },
    {
      name: "only limit denials",
      decision: denied({
        role: "member",
        reason: "limit",
        detail: { count: 10, per: 60, resetsAt: at(Date.now() / 1000 + 30) },
      }),
      status: 429,
      type: "rate-limited",
      challenge: null,
    },
    {
      name: "an unavailable limit store",
      decision: denied(
        { role: "member", reason: "limit-unavailable" },
        {
          role: "admin",
          reason: "limit",
          detail: { count: 1, per: 60, resetsAt: at(Date.now() / 1000 + 30) },
        },
      ),
      status: 503,
      type: "limit-unavailable",
      challenge: null,
    },
    {
      name: "a hidden row",
      decision: denied({ role: "member", reason: "condition" }),
      status: 404,
      type: "about:blank",
      challenge: null,
      disclosure: "hide",
    },
    {
      name: "a hidden row that only needs a step-up",
      decision: denied({
        role: "member",
        reason: "insufficient-user-authentication",
        to: { kind: "assurance", acr: ["urn:mfa"] },
      }),
      status: 401,
      type: "step-up-required",
      challenge:
        'Bearer error="insufficient_user_authentication", acr_values="urn:mfa"',
      disclosure: "hide",
    },
    {
      name: "any other denial",
      decision: denied({ role: "member", reason: "condition" }),
      status: 403,
      type: "denied",
      challenge: null,
    },
    {
      name: "an approval",
      decision: {
        outcome: "approval-required",
        grant: {
          role: "member",
          permission: permission.key,
          approval: "human",
        },
        reason: "human",
        token: "sha256:abc",
      },
      status: 403,
      type: "approval-required",
      challenge: null,
    },
  ];

  for (const row of rows) {
    it(`answers ${row.name} with ${String(row.status)} /${row.type}`, async () => {
      const response = problemFromDecision(row.decision, permission, subject, {
        instance: "/posts/p1",
        ...(row.disclosure === undefined ? {} : { disclosure: row.disclosure }),
      });
      expect(response.status).toBe(row.status);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("WWW-Authenticate")).toBe(row.challenge);
      const problem = await body(response);
      expect(problem["type"]).toBe(
        row.type === "about:blank" ? row.type : `${PROBLEM_BASE}/${row.type}`,
      );
      expect(problem["status"]).toBe(row.status);
      expect(problem["title"]).toBeTypeOf("string");
    });
  }

  it("uses the fixed base, never a configurable host", () => {
    expect(PROBLEM_BASE).toBe("https://permdock.com/problems");
  });

  it("defines PermDock types only where about:blank says too little", () => {
    expect(PROBLEM_TYPES).toEqual([
      "denied",
      "approval-required",
      "validation",
      "step-up-required",
      "not-entitled",
      "rate-limited",
      "limit-unavailable",
      "invalid-signature",
      "approver-not-eligible",
    ]);
    expect(problemType("denied")).toBe(`${PROBLEM_BASE}/denied`);
    expect(statusProblem(409, "approval is not pending")).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "approval is not pending",
    });
    expect(statusProblem(599, "x").title).toBe("Error");
  });

  it("answers 405 with Allow and an about:blank body", async () => {
    const response = methodNotAllowed("GET, POST");
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Method Not Allowed",
      status: 405,
      detail: "use GET, POST",
    });
  });

  it("carries permission, denials and alternatives as wire keys on a denial", async () => {
    const problem = await body(
      problemFromDecision(
        denied({ role: "member", reason: "condition" }),
        permission,
        subject,
        { instance: "/posts/p1" },
      ),
    );
    expect(problem).toMatchObject({
      instance: "/posts/p1",
      permission: permission.key,
      denials: [{ role: "member", reason: "condition" }],
      alternatives: [permissions.post.read.key],
    });
    expect(problem["detail"]).toBeTypeOf("string");
  });

  it("never explains the failure to an unauthenticated caller", async () => {
    const problem = await body(
      problemFromDecision(
        denied({
          role: null,
          reason: "anonymous",
          detail: "signature mismatch",
        }),
        permission,
        subject,
      ),
    );
    expect(problem).not.toHaveProperty("denials");
    expect(problem).not.toHaveProperty("alternatives");
    expect(JSON.stringify(problem)).not.toContain("signature mismatch");
  });

  it("carries acrValues and maxAge on a step-up", async () => {
    const problem = await body(
      problemFromDecision(
        denied({
          role: "member",
          reason: "insufficient-user-authentication",
          to: { kind: "assurance", acr: ["urn:mfa"], maxAge: 60 },
        }),
        permission,
        subject,
      ),
    );
    expect(problem).toMatchObject({ acrValues: ["urn:mfa"], maxAge: 60 });
  });

  it("lists the plans in grant order on not-entitled", async () => {
    const problem = await body(
      problemFromDecision(
        denied(
          {
            role: "admin",
            reason: "not-entitled",
            to: { kind: "plan", plan: "pro" },
          },
          {
            role: "owner",
            reason: "not-entitled",
            to: [{ kind: "plan", plan: "enterprise" }],
          },
        ),
        permission,
        subject,
      ),
    );
    expect(problem["plans"]).toEqual(["pro", "enterprise"]);
  });

  it("sends Retry-After, RateLimit and RateLimit-Policy with a 429", () => {
    const response = problemFromDecision(
      denied({
        role: "member",
        reason: "limit",
        detail: { count: 10, per: 60, resetsAt: at(Date.now() / 1000 + 30) },
      }),
      permission,
      subject,
    );
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/u);
    expect(response.headers.get("RateLimit")).toMatch(/^"member";r=0;t=\d+$/u);
    expect(response.headers.get("RateLimit-Policy")).toBe('"member";q=10;w=60');
  });

  it("carries the token and the approval hint on approval-required", async () => {
    const problem = await body(
      problemFromDecision(
        {
          outcome: "approval-required",
          grant: {
            role: "member",
            permission: permission.key,
            approval: "human",
          },
          reason: "human",
          token: "sha256:abc",
        },
        permission,
        subject,
        { approval: { at: "https://app.example/approvals" } },
      ),
    );
    expect(problem).toMatchObject({
      permission: permission.key,
      token: "sha256:abc",
      approval: { at: "https://app.example/approvals" },
    });
    expect(problem).not.toHaveProperty("denials");
  });

  it("answers a boundary validation failure with 400 /validation and issues", async () => {
    const error = new PermDockValidationError({
      code: "invalid-data",
      permission: permission.key,
      resource: permission.resource,
      issues: [{ message: "title is required", path: ["title"] }],
      boundary: "http-body",
      message: "invalid post",
    });
    const response = problemFromDecision(
      denied({ role: null, reason: "validation", detail: error }),
      permission,
      subject,
    );
    expect(response.status).toBe(400);
    const problem = await body(response);
    expect(problem["type"]).toBe(`${PROBLEM_BASE}/validation`);
    expect(problem["issues"]).toEqual([
      { message: "title is required", path: ["title"] },
    ]);
    expect(problem).not.toHaveProperty("denials");
  });

  describe("the 401 challenge follows the request credentials (RFC 6750 section 3.1)", () => {
    const { protect } = createPermDock(policy, { subject: () => null });
    const guard = protect(permissions.post.read);

    it("omits the error code when the request had no credentials", async () => {
      const result = await guard(new Request("https://api.example/posts"));
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("answers invalid_token when the request carried a token", async () => {
      const result = await guard(
        new Request("https://api.example/posts", {
          headers: { authorization: "Bearer expired" },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.response.headers.get("WWW-Authenticate")).toBe(
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
    });
  });
});

describe("PROBLEM_EXAMPLES", () => {
  const author = {
    principal: { id: "u_123", roles: ["member"] },
    context: {},
  };
  const remove = permissions.post.delete;
  const refused = (...denials: readonly Denial[]): Decision => ({
    outcome: "denied",
    denials,
    alternatives: [permissions.post.read, permissions.post.update],
  });

  async function approverRefusal(): Promise<Response> {
    const store = memoryApprovalStore();
    const now = Temporal.Now.instant();
    store.create({
      v: 1,
      id: "apr_1",
      token: "pd1.request",
      permission: remove.key,
      scope: remove.scope,
      resource: { type: "post", id: "p_42" },
      subject: { principal: author.principal },
      detail: "post.delete requires human approval.",
      createdAt: now.toString(),
      expiresAt: now.add({ minutes: 1 }).toString(),
      status: "pending",
    });
    const handler = approvalsHandler(store, { subject: () => author });
    return handler(
      new Request("https://api.example/permdock/approvals/apr_1/approve", {
        method: "POST",
      }),
    );
  }

  const emitters: Readonly<
    Record<ProblemType, () => Response | Promise<Response>>
  > = {
    denied: () =>
      problemFromDecision(
        refused({ role: "member", reason: "condition" }),
        remove,
        author,
        { instance: "/posts/p_42" },
      ),
    "approval-required": () =>
      problemFromDecision(
        {
          outcome: "approval-required",
          grant: { role: "member", permission: remove.key, approval: "human" },
          reason: "human",
          token: "pd1.eyJhbGciOiJFZERTQSJ9",
        },
        remove,
        author,
        {
          instance: "/posts/p_42",
          approval: { at: "https://app.example/approvals" },
        },
      ),
    validation: () =>
      problemFromDecision(
        refused({
          role: null,
          reason: "validation",
          detail: new PermDockValidationError({
            code: "invalid-data",
            permission: remove.key,
            resource: remove.resource,
            issues: [{ message: "title is required", path: ["title"] }],
            boundary: "http-body",
            message: "invalid post",
          }),
        }),
        remove,
        author,
      ),
    "step-up-required": () =>
      problemFromDecision(
        refused({
          role: "member",
          reason: "insufficient-user-authentication",
          to: { kind: "assurance", acr: ["urn:mfa"], maxAge: 600 },
        }),
        remove,
        author,
      ),
    "not-entitled": () =>
      problemFromDecision(
        refused({
          role: "admin",
          reason: "not-entitled",
          to: { kind: "plan", plan: "pro" },
        }),
        remove,
        author,
      ),
    "rate-limited": () =>
      problemFromDecision(
        refused({
          role: "member",
          reason: "limit",
          detail: { count: 10, per: 60, resetsAt: at(1_900_000_000) },
        }),
        remove,
        author,
      ),
    "limit-unavailable": () =>
      problemFromDecision(
        refused({ role: "member", reason: "limit-unavailable" }),
        remove,
        author,
      ),
    "invalid-signature": () =>
      invalidSignatureProblem("HTTP Message Signature did not verify"),
    "approver-not-eligible": approverRefusal,
  };

  it.each(PROBLEM_TYPES)(
    "%s is the body the emitting code writes",
    async (type) => {
      const response = await emitters[type]();
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.status).toBe(PROBLEM_EXAMPLES[type].status);
      expect(await response.json()).toEqual(PROBLEM_EXAMPLES[type]);
    },
  );

  it("the docs show each example under its problem type heading", () => {
    const page = readFileSync(
      path.join(
        import.meta.dirname,
        "../../../../apps/docs/content/docs/standards/problem-details.mdx",
      ),
      "utf8",
    );
    const section = page.slice(page.indexOf("\n## Problem types\n"));
    for (const type of PROBLEM_TYPES) {
      const start = section.indexOf(`\n### ${type}\n`);
      expect({ type, start: start >= 0 }).toEqual({ type, start: true });
      const fence = /```json\n([\s\S]*?)\n```/u.exec(
        section.slice(start).split(/\n### /u)[1] ?? "",
      );
      const shown: unknown = JSON.parse(fence?.[1] ?? "null");
      expect({ type, shown }).toEqual({ type, shown: PROBLEM_EXAMPLES[type] });
    }
  });
});
