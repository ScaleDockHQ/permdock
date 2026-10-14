import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";

import { approvalPrompt, approvalUrlFor } from "../../src/delivery/index.ts";
import { deliveryOperations } from "../fixtures/delivery.ts";

const request: ApprovalRequest = {
  v: 1,
  id: "apr_1",
  token: "secret-token",
  permission: "invoice.pay",
  scope: "tenant",
  resource: { type: "invoice", id: "i1" },
  subject: {
    principal: { id: "u_2", roles: ["member"], tenant: "o1" },
    actor: { id: "agent_1", kind: "agent" },
  },
  membership: { scope: "tenant", id: "o1", roles: ["member"] },
  detail: "Pay invoice i1",
  createdAt: "2026-10-14T10:00:00.000Z",
  expiresAt: "2026-10-15T10:00:00.000Z",
  status: "pending",
};

describe("approvalPrompt", () => {
  it("is ApprovalPrompt v1 without the token, roles or membership", () => {
    const prompt = approvalPrompt(request, {
      operation: deliveryOperations["invoice.send"],
    });
    expect(prompt).toEqual({
      v: 1,
      id: "apr_1",
      permission: "invoice.pay",
      scope: "tenant",
      resource: { type: "invoice", id: "i1" },
      requester: {
        principal: { id: "u_2" },
        actor: { id: "agent_1", kind: "agent" },
      },
      tenant: "o1",
      detail: "Pay invoice i1",
      createdAt: "2026-10-14T10:00:00.000Z",
      expiresAt: "2026-10-15T10:00:00.000Z",
      operation: {
        name: "invoice.send",
        title: "Send an invoice",
        risk: "low",
        effects: ["send"],
      },
    });
    expect(JSON.stringify(prompt)).not.toContain("secret-token");
    expect(Object.isFrozen(prompt.resource)).toBe(true);
  });

  it("throws for a request that is no longer pending", () => {
    expect(() => approvalPrompt({ ...request, status: "approved" })).toThrow(
      TypeError,
    );
  });
});

describe("approvalUrlFor", () => {
  const prompt = approvalPrompt(request);

  it("appends the request id to a base URL", () => {
    expect(approvalUrlFor(prompt, "https://acme.test/approvals")).toBe(
      "https://acme.test/approvals/apr_1",
    );
    expect(
      approvalUrlFor(prompt, new URL("https://acme.test/approvals/")),
    ).toBe("https://acme.test/approvals/apr_1");
  });

  it("takes the URL a function returns", () => {
    expect(
      approvalUrlFor(prompt, (entry) => `https://acme.test/a?id=${entry.id}`),
    ).toBe("https://acme.test/a?id=apr_1");
  });

  it("throws for a URL that is not https", () => {
    expect(() => approvalUrlFor(prompt, "http://acme.test/a")).toThrow(
      TypeError,
    );
    expect(() => approvalUrlFor(prompt, "javascript:alert(1)")).toThrow(
      TypeError,
    );
  });
});
