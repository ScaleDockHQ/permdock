import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";

import {
  approvalEntityTag,
  approvalView,
  approvalsHandler,
  memoryApprovalStore,
} from "../../src/approvals/index.ts";
import { canonicalJson, sha256Digest } from "../../src/index.ts";

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const request: ApprovalRequest = {
  v: 1,
  id: "apr_1",
  token: "pd1.apr_1",
  permission: "post.delete",
  scope: "post:delete",
  resource: { type: "post", id: "42" },
  subject: { principal: { id: "u_1" } },
  detail: "post.delete requires human approval.",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: future,
};

describe("approvalEntityTag", () => {
  it("is the quoted digest of the view, which leaves out only the token", () => {
    const { token: _token, ...rest } = request;
    expect(approvalView(request)).toEqual(rest);
    expect(approvalEntityTag(request)).toBe(
      `"${sha256Digest(canonicalJson(rest))}"`,
    );
  });

  it("changes when the hashed request carries an extra field", () => {
    const extra = { ...request, environmentId: "env_1" };
    expect(approvalEntityTag(extra)).not.toBe(approvalEntityTag(request));
  });

  it("is the ETag the approvals handler serves", async () => {
    const store = memoryApprovalStore();
    await store.create(request);
    const handler = approvalsHandler(store, {
      subject: () => ({ principal: { id: "u_1" } }),
    });
    const response = await handler(
      new Request("https://api.example.com/approvals/apr_1"),
    );
    expect(response.status).toBe(200);
    const stored = await store.getById?.("apr_1");
    expect(stored).toBeDefined();
    expect(response.headers.get("etag")).toBe(
      approvalEntityTag(stored ?? request),
    );
  });
});
