import type { ProblemDetails } from "../core/errors.ts";
import type { ProblemType } from "../core/problem-types.ts";

/**
 * One RFC 9457 body per PermDock problem type, exactly as the HTTP adapters
 * write it for a `post.delete` request by subject `u_123`. A client tests its
 * error handling against these; `tests/standards/problem-details.test.ts`
 * rebuilds each from the code that emits it, and the docs show the same JSON.
 */
export const PROBLEM_EXAMPLES: Readonly<Record<ProblemType, ProblemDetails>> =
  Object.freeze({
    denied: {
      type: "https://permdock.com/problems/denied",
      title: "Permission denied",
      status: 403,
      detail:
        "post.delete denied for subject u_123: member (condition). Alternatives: post.read, post.update.",
      instance: "/posts/p_42",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      denials: [{ role: "member", reason: "condition" }],
      alternatives: ["post.read", "post.update"],
    },
    "approval-required": {
      type: "https://permdock.com/problems/approval-required",
      title: "Approval required",
      status: 403,
      detail:
        "post.delete requires human approval (human). Token: pd1.eyJhbGciOiJFZERTQSJ9.",
      instance: "/posts/p_42",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      reason: "human",
      token: "pd1.eyJhbGciOiJFZERTQSJ9",
      approval: { at: "https://app.example/approvals" },
    },
    validation: {
      type: "https://permdock.com/problems/validation",
      title: "Invalid resource data",
      status: 400,
      detail: "invalid post",
      permission: "post.delete",
      issues: [{ message: "title is required", path: ["title"] }],
    },
    "step-up-required": {
      type: "https://permdock.com/problems/step-up-required",
      title: "Step-up required",
      status: 401,
      detail:
        "post.delete denied for subject u_123: member (insufficient-user-authentication). Alternatives: post.read, post.update.",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      denials: [
        {
          role: "member",
          reason: "insufficient-user-authentication",
          to: { kind: "assurance", acr: ["urn:mfa"], maxAge: 600 },
        },
      ],
      alternatives: ["post.read", "post.update"],
      acrValues: ["urn:mfa"],
      maxAge: 600,
    },
    "not-entitled": {
      type: "https://permdock.com/problems/not-entitled",
      title: "Plan upgrade required",
      status: 403,
      detail:
        "post.delete denied for subject u_123: admin (not-entitled). Alternatives: post.read, post.update.",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      denials: [
        {
          role: "admin",
          reason: "not-entitled",
          to: { kind: "plan", plan: "pro" },
        },
      ],
      alternatives: ["post.read", "post.update"],
      plans: ["pro"],
    },
    "rate-limited": {
      type: "https://permdock.com/problems/rate-limited",
      title: "Rate limit exceeded",
      status: 429,
      detail:
        "post.delete denied for subject u_123: member (limit). Alternatives: post.read, post.update.",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      denials: [
        {
          role: "member",
          reason: "limit",
          detail: { count: 10, window: 60, resetsAt: 1_900_000_000 },
        },
      ],
      alternatives: ["post.read", "post.update"],
    },
    "limit-unavailable": {
      type: "https://permdock.com/problems/limit-unavailable",
      title: "Rate limit unavailable",
      status: 503,
      detail:
        "post.delete denied for subject u_123: member (limit-unavailable). Alternatives: post.read, post.update.",
      permission: "post.delete",
      scope: "post:delete",
      resource: { type: "post" },
      denials: [{ role: "member", reason: "limit-unavailable" }],
      alternatives: ["post.read", "post.update"],
    },
    "invalid-signature": {
      type: "https://permdock.com/problems/invalid-signature",
      title: "Invalid signature",
      status: 403,
      detail: "HTTP Message Signature did not verify",
    },
    "approver-not-eligible": {
      type: "https://permdock.com/problems/approver-not-eligible",
      title: "Approver not eligible",
      status: 403,
      detail: "approver is the principal of this request",
      reason: "approver-is-principal",
    },
  });
