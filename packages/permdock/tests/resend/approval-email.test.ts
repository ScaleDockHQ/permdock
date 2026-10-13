import { describe, expect, it } from "vitest";

import type { ApprovalPrompt } from "../../src/delivery/index.ts";

import { approvalEmail } from "../../src/resend/index.ts";

const prompt: ApprovalPrompt = {
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
  detail: "Pay <invoice> i1 & more",
  createdAt: "2026-10-14T10:00:00.000Z",
  expiresAt: "2026-10-15T10:00:00.000Z",
  operation: { name: "invoice.pay", title: "Pay an invoice", risk: "high" },
};

describe("approvalEmail", () => {
  it("renders an approval-category email that links to the approval page", () => {
    const email = approvalEmail(prompt, {
      approvalUrl: "https://acme.test/approvals",
    });
    expect(email.category).toBe("approval");
    expect(email.subject).toBe("Approval needed: Pay an invoice");
    expect(email.text).toContain("https://acme.test/approvals/apr_1");
    expect(email.text).toContain("Pay <invoice> i1 & more");
    expect(email.text).toContain("Requested by u_2 through agent agent_1");
    expect(email.text).toContain("Expires 2026-10-15T10:00:00.000Z");
    expect(email.html).toContain('href="https://acme.test/approvals/apr_1"');
    expect(email.html).toContain("Pay &lt;invoice&gt; i1 &amp; more");
    expect(email.html).not.toContain("<invoice>");
    expect(email.unsubscribe).toBeUndefined();
  });

  it("names no approve or reject action: the page decides", () => {
    const email = approvalEmail(prompt, {
      approvalUrl: (entry) => `https://acme.test/review?id=${entry.id}`,
    });
    const links = [...(email.html ?? "").matchAll(/href="([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(links).toEqual(["https://acme.test/review?id=apr_1"]);
    expect(email.text).not.toMatch(/approve=|decision=|token/iu);
  });

  it("falls back to the detail for the subject and drops line breaks", () => {
    const { operation: _operation, ...bare } = prompt;
    const email = approvalEmail(
      { ...bare, detail: "Delete\r\nproject p1" },
      { approvalUrl: "https://acme.test/approvals" },
    );
    expect(email.subject).toBe("Approval needed: Delete project p1");
  });

  it("throws for an approval page that is not https", () => {
    expect(() =>
      approvalEmail(prompt, { approvalUrl: "http://acme.test/approvals" }),
    ).toThrow(TypeError);
  });
});
