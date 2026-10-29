import { describe, expect, it } from "vitest";

import type {
  ApprovalRequest,
  ApproverDirectory,
} from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { normalizeApproval } from "../../src/core/approval-normalize.ts";
import { tightenApproval } from "../../src/core/approval-policies.ts";

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function subject(id: string): Subject {
  return { principal: { id, roles: ["admin"] }, context: {} };
}

function request(fallback: "confirm" | undefined): ApprovalRequest {
  return {
    v: 1,
    id: "apr_1",
    token: "pd1.token-1",
    permission: "post.delete",
    scope: "post:delete",
    resource: { type: "post", id: "42" },
    subject: { principal: { id: "u_1", roles: ["admin"] } },
    detail: "post.delete requires human approval.",
    adapter: "eve",
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: "pending",
    approvers: {
      by: { kind: "role", role: "admin", scope: "global" },
      ...(fallback === undefined ? {} : { fallback }),
    },
  };
}

function directory(
  ids: readonly string[] | null | "throws",
): ApproverDirectory {
  return {
    approversFor() {
      if (ids === "throws") {
        throw new Error("down");
      }
      return ids;
    },
  };
}

async function resolveAs(
  fallback: "confirm" | undefined,
  approverDirectory: ApproverDirectory | undefined,
  options: { requireDistinctApprover?: boolean } = {},
) {
  const store = memoryApprovalStore();
  await store.create(request(fallback));
  return resolveApproval(
    store,
    "pd1.token-1",
    { status: "approved", by: subject("u_1") },
    {
      ...options,
      ...(approverDirectory === undefined ? {} : { approverDirectory }),
    },
  );
}

describe("approval fallback: 'confirm'", () => {
  it("lets the principal approve when the directory lists nobody else", async () => {
    const done = await resolveAs("confirm", directory(["u_1"]));
    expect(done.status).toBe("approved");
  });

  it("refuses the principal while another approver exists", async () => {
    await expect(
      resolveAs("confirm", directory(["u_1", "u_2"])),
    ).rejects.toMatchObject({ code: "approver-is-principal" });
  });

  it.each([
    ["no directory", undefined],
    ["a null answer", directory(null)],
    ["a throwing directory", directory("throws")],
  ])("refuses the principal with %s", async (_label, approverDirectory) => {
    await expect(resolveAs("confirm", approverDirectory)).rejects.toMatchObject(
      { code: "approver-is-principal" },
    );
  });

  it("refuses without the fallback on the request", async () => {
    await expect(resolveAs(undefined, directory([]))).rejects.toMatchObject({
      code: "approver-is-principal",
    });
  });

  it("is overridden by requireDistinctApprover", async () => {
    await expect(
      resolveAs("confirm", directory([]), { requireDistinctApprover: true }),
    ).rejects.toMatchObject({ code: "approver-is-principal" });
  });
});

describe("approval fallback in policy", () => {
  it("is kept by normalizeApproval", () => {
    expect(
      normalizeApproval({ by: "admin", fallback: "confirm" }, "p"),
    ).toMatchObject({ fallback: "confirm" });
  });

  it("is rejected when it is not 'confirm'", () => {
    expect(() =>
      // @ts-expect-error: only 'confirm' is a fallback.
      normalizeApproval({ fallback: "skip" }, "p"),
    ).toThrow("fallback");
  });

  it("survives tightening only when every authorizing part has it", () => {
    const tighten = (
      code: Parameters<typeof tightenApproval>[0],
      entry: Parameters<typeof tightenApproval>[1][number]["approval"],
    ) =>
      tightenApproval(code, [{ permission: "post.delete", approval: entry }], {
        permission: "post.delete",
        tenant: undefined,
        subject: subject("u_9"),
        current: undefined,
        next: undefined,
        now: 0,
        scopes: [],
      });
    const withFallback = normalizeApproval({
      by: "admin",
      fallback: "confirm",
    });
    const without = normalizeApproval({ by: "editor" });
    expect(tighten(withFallback, withFallback ?? "human")).toMatchObject({
      fallback: "confirm",
    });
    expect(tighten(withFallback, without ?? "human")).not.toHaveProperty(
      "fallback",
    );
    expect(tighten(withFallback, "human")).not.toHaveProperty("fallback");
  });
});
